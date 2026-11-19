import { getHeapStatistics } from 'node:v8';

import {
  UNTRUSTED_DEFINITION_SANDBOX_CAPS,
  type UntrustedDefinitionSandboxAttestation,
} from '@north-star/compiler';

import { compileCustomizationCandidate } from './candidate.js';
import {
  parseSerializedRelease,
  serializeRelease,
} from './release-envelope.js';
import {
  SANDBOX_PROTOCOL_VERSION,
  type SandboxRequest,
  type SandboxResponse,
  type SandboxStep,
} from './sandbox.js';

/**
 * The isolated compile worker. It is the ONLY code that declares the
 * untrusted-definition sandbox attestation, and it declares only what it
 * observes about its own process: that a parent holds its IPC channel, that it
 * was started with an explicit heap ceiling, what that ceiling is, and the wall
 * clock its runner will kill it at. Anything else and it refuses to compile.
 */
const observed = observeSandbox();

process.once('message', (message: unknown) => {
  const reply = (body: Record<string, unknown>) => {
    process.send?.({ protocol: SANDBOX_PROTOCOL_VERSION, ...body }, () => {
      process.exit(0);
    });
  };
  if (typeof observed === 'string') {
    reply({ environmentRefusal: observed });
    return;
  }
  const envelope = message as { protocol?: unknown; request?: SandboxRequest };
  if (envelope.protocol !== SANDBOX_PROTOCOL_VERSION || !envelope.request) {
    reply({
      environmentRefusal: 'the request is outside the sandbox protocol',
    });
    return;
  }
  reply({ response: compileChain(envelope.request, observed) });
});

function compileChain(
  request: SandboxRequest,
  sandbox: UntrustedDefinitionSandboxAttestation,
): SandboxResponse {
  let parent = parseSerializedRelease(request.tip);
  const steps: SandboxStep[] = [];
  for (
    let length = request.upgradeBaseRoot
      ? request.chain.length
      : (request.startAt ?? 0) + 1;
    length <= request.chain.length;
    length += 1
  ) {
    const result = compileCustomizationCandidate({
      acknowledgement: request.acknowledgement,
      base: request.base,
      chain: request.chain.slice(0, length),
      parent,
      ...(request.historical ? { historical: true } : {}),
      sandbox,
    });
    if (request.upgradeBaseRoot && result.status !== 'compiled') {
      if (!('patchIndex' in result)) {
        const details = result.diagnostics.length ? result.diagnostics : [null];
        return {
          code: 'CUSTOMIZE_UPGRADE_CONFLICT',
          status: 'rejected',
          message: result.message,
          diagnostics: details.map((detail) => ({
            code: 'CUSTOMIZE_UPGRADE_CONFLICT',
            firstPartyBase: request.upgradeBaseRoot,
            ...(detail && typeof detail === 'object' && 'subjectId' in detail
              ? { firstPartySubject: detail.subjectId }
              : {}),
            reason: result.message,
            details: detail ? [detail] : [],
          })),
        };
      }
      const patchIndex = result.patchIndex;
      const tenantPatch = request.chain[patchIndex]!;
      let firstPartySubject: string | undefined;
      if (tenantPatch.kind === 'addField') {
        const collision = (
          (request.base.fields ?? []) as Record<string, unknown>[]
        ).find(
          (field) =>
            (field.entity as { targetId?: string } | undefined)?.targetId ===
              tenantPatch.entity &&
            String(field.label).toLowerCase() ===
              tenantPatch.field.label.trim().toLowerCase(),
        );
        firstPartySubject = String(collision?.fieldId ?? tenantPatch.entity);
      } else if (tenantPatch.kind === 'arrangeLayout') {
        firstPartySubject = tenantPatch.surface;
      }
      return {
        code: 'CUSTOMIZE_UPGRADE_CONFLICT',
        diagnostics: [
          {
            code: 'CUSTOMIZE_UPGRADE_CONFLICT',
            firstPartyBase: request.upgradeBaseRoot,
            firstPartySubject,
            tenantPatch,
            patchIndex,
            reason: result.message,
            details: [],
          },
        ],
        message:
          'a recorded tenant patch conflicts with the new first-party base',
        patchIndex,
        status: 'rejected',
      };
    }
    if (result.status === 'refused') {
      return {
        code: result.code,
        message: result.message,
        patchIndex: result.patchIndex,
        status: 'refused',
      };
    }
    if (result.status === 'unsupported') {
      return {
        message: result.message,
        missingCapability: result.missingCapability,
        patchIndex: result.patchIndex,
        status: 'unsupported',
      };
    }
    if (result.status === 'rejected') {
      return {
        diagnostics: result.diagnostics,
        message: result.message,
        patchIndex: length - 1,
        status: 'rejected',
      };
    }
    steps.push({
      diff: result.diff,
      release: serializeRelease(result),
      rendered: result.rendered,
    });
    parent = result;
  }
  return { status: 'compiled', steps };
}

function observeSandbox(): UntrustedDefinitionSandboxAttestation | string {
  if (typeof process.send !== 'function') {
    return 'the sandbox worker runs only under a parent that holds its IPC channel';
  }
  if (
    !process.execArgv.some((argument) =>
      argument.startsWith('--max-old-space-size='),
    )
  ) {
    return 'the sandbox worker requires an explicit heap ceiling';
  }
  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  const wallClockLimitMilliseconds = Number(
    process.env.NORTH_STAR_SANDBOX_WALL_CLOCK_MS,
  );
  if (
    heapLimitBytes > UNTRUSTED_DEFINITION_SANDBOX_CAPS.maximumHeapLimitBytes ||
    !Number.isSafeInteger(wallClockLimitMilliseconds) ||
    wallClockLimitMilliseconds <= 0 ||
    wallClockLimitMilliseconds >
      UNTRUSTED_DEFINITION_SANDBOX_CAPS.maximumWallClockLimitMilliseconds
  ) {
    return 'the sandbox worker limits exceed the untrusted-definition caps';
  }
  // The worker enforces its own wall clock too, in case the runner's is lost.
  setTimeout(() => process.exit(70), wallClockLimitMilliseconds).unref();
  return {
    heapLimitBytes,
    kind: 'processIsolatedCompile',
    wallClockLimitMilliseconds,
  };
}

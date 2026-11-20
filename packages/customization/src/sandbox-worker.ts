import {
  UPGRADE_CODES_V1,
  type UpgradeFinding,
} from './upgrade-diagnostics.js';
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
      acknowledgement:
        request.stepAcknowledgements?.[steps.length] ?? request.acknowledgement,
      base: request.base,
      chain: request.chain.slice(0, length),
      parent,
      ...(request.historical ? { historical: true } : {}),
      ...(request.origins && { origins: request.origins }),
      upgradeReplay: !!request.upgradeBaseRoot,
      ...(request.activeRoleKeys && { activeRoleKeys: request.activeRoleKeys }),
      sandbox,
    });
    if (result.status === 'replayConflict') {
      const { findings, blocked } = result;
      const code = findings[0]!.code;
      return {
        code,
        message: UPGRADE_CODES_V1[code],
        status: 'rejected',
        replayDiagnostics: { findings, blocked },
        diagnostics: findings.map((finding) => ({
          ...finding,
          firstPartyBase: request.upgradeBaseRoot,
        })),
      };
    }
    if (request.upgradeBaseRoot && result.status === 'rejected') {
      const findings: UpgradeFinding[] = (
        result.diagnostics.length ? result.diagnostics : [null]
      ).map((raw) => {
        const detail = raw as { subjectId?: string; message?: string } | null;
        const subject = detail?.subjectId ?? request.upgradeBaseRoot!;
        const patchIndex = request.chain.findIndex(
          (p) => p.kind === 'addValidation' && p.rule.ruleId === subject,
        );
        const patch = request.chain[patchIndex];
        if (
          patch?.kind === 'addValidation' &&
          /satisfying and violating/u.test(detail?.message ?? '')
        )
          return {
            code: 'UNSATISFIABLE_RULE',
            subject,
            expected: patch.rule.ruleId,
            observed: detail,
            patchIndex,
            patchKind: patch.kind,
            memberIndex: 0,
            editIndex: 0,
            ...(request.origins?.[patchIndex] && {
              patchId: request.origins[patchIndex]!.patchId,
            }),
          };
        return {
          code: 'WHOLE_PACKAGE_FAILURE',
          subject,
          expected: request.upgradeBaseRoot,
          observed: detail ?? result.message,
        };
      });
      return {
        status: 'rejected',
        code: findings[0]!.code,
        message: result.message,
        diagnostics: findings.map((finding) => ({
          ...finding,
          firstPartyBase: request.upgradeBaseRoot,
        })),
        replayDiagnostics: { findings, blocked: [] },
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

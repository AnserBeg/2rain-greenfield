import type { ReplayDiagnostics, ReplayOrigin } from './upgrade-diagnostics.js';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ReleaseDiffEnvelope } from '@north-star/compiler';

import type { AcknowledgementInput } from './candidate.js';
import type { CustomizationPatch } from './patch.js';
import type { RenderedReleaseDiff } from './render.js';
import type { SerializedRelease } from './release-envelope.js';

/**
 * The untrusted-definition release gate's runner. Every tenant-authored
 * compile happens in a separate Node process started with a bounded heap and
 * killed at a wall-clock limit; the serving process -- the dev server, the
 * command line -- never compiles a tenant definition itself.
 */
export const SANDBOX_PROTOCOL_VERSION =
  'northstar.customization-sandbox/v2' as const;
export const SANDBOX_DEFAULT_LIMITS = Object.freeze({
  heapLimitMegabytes: 1024,
  wallClockLimitMilliseconds: 90_000,
});

export interface SandboxRequest {
  readonly acknowledgement: AcknowledgementInput;
  /** The first-party authored application the chain applies to. */
  readonly base: Readonly<Record<string, unknown>>;
  /** Every patch from the base to the candidate, in order. */
  readonly chain: readonly CustomizationPatch[];
  /** The first-party release the base compiles to. */
  readonly tip: SerializedRelease;
  /** Already reproduced chain prefix. The next step compiles its successor. */
  readonly startAt?: number;
  /** Reproducing an already recorded revision uses its own permission census. */
  readonly historical?: boolean;
  readonly stepAcknowledgements?: readonly AcknowledgementInput[];
  /** Replay the entire chain once against tip, the previously live release. */
  readonly upgradeBaseRoot?: string;
  readonly origins?: readonly ReplayOrigin[];
  readonly activeRoleKeys?: readonly string[];
}

export interface SandboxStep {
  readonly diff: ReleaseDiffEnvelope;
  readonly release: SerializedRelease;
  readonly rendered: RenderedReleaseDiff;
}

export type SandboxResponse =
  | {
      readonly status: 'compiled';
      /** One per chain prefix: steps[i] applies chain[0..i]. */
      readonly steps: readonly SandboxStep[];
    }
  | {
      readonly code?: string;
      readonly replayDiagnostics?: ReplayDiagnostics;
      readonly diagnostics?: readonly unknown[];
      readonly message: string;
      readonly missingCapability?: string;
      readonly patchIndex?: number;
      readonly status: 'refused' | 'rejected' | 'unsupported';
    };

export class SandboxFailure extends Error {
  override readonly name = 'SandboxFailure';
  constructor(
    readonly code:
      | 'SANDBOX_CRASHED'
      | 'SANDBOX_PROTOCOL_INVALID'
      | 'SANDBOX_REFUSED_ENVIRONMENT'
      | 'SANDBOX_TIMED_OUT',
    message: string,
  ) {
    super(message);
  }
}

export interface SandboxRunnerOptions {
  readonly heapLimitMegabytes?: number;
  /** Test seam: replaces the process launch. */
  readonly launch?: (
    workerPath: string,
    execArgv: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ChildProcess;
  /** Test seam for the wall clock; returns a cancel function. */
  readonly startTimer?: (
    milliseconds: number,
    onExpiry: () => void,
  ) => () => void;
  readonly wallClockLimitMilliseconds?: number;
}

// The production entry lives under dist/. Its workspace dependencies and the
// fork's native TypeScript loader are installed alongside the source packages.
const root = new URL(
  import.meta.url.endsWith('.ts') ? '../../../' : '../../../../',
  import.meta.url,
);
const workers = {
  compile: 'packages/customization/src/sandbox-worker.ts',
  verifyWorkflowDraft:
    'packages/postgres-provider/src/workflow-draft-worker.ts',
} as const;

export async function compileInSandbox(
  request: SandboxRequest,
  options: SandboxRunnerOptions = {},
): Promise<SandboxResponse> {
  return runSandboxRequest(
    'compile',
    request,
    options,
    SANDBOX_DEFAULT_LIMITS,
    (value) => value as SandboxResponse,
  );
}

/** A fresh fork and the same closed environment for every protocol request. */
export function runSandboxRequest<T>(
  kind: 'compile' | 'verifyWorkflowDraft',
  request: unknown,
  options: SandboxRunnerOptions,
  limits: {
    readonly heapLimitMegabytes: number;
    readonly wallClockLimitMilliseconds: number;
  },
  parse: (response: unknown) => T,
): Promise<T> {
  const heap = Math.min(
    options.heapLimitMegabytes ?? Infinity,
    limits.heapLimitMegabytes,
  );
  const wallClock = Math.min(
    options.wallClockLimitMilliseconds ?? Infinity,
    limits.wallClockLimitMilliseconds,
  );
  const path = fileURLToPath(new URL(workers[kind], root));
  const execArgv = [
    `--max-old-space-size=${heap}`,
    '--permission',
    ...(kind === 'verifyWorkflowDraft' ? ['--allow-worker'] : []),
    ...['packages', 'node_modules', 'package.json'].map(
      (name) => `--allow-fs-read=${fileURLToPath(new URL(name, root))}`,
    ),
    '--experimental-transform-types',
    '--import',
    new URL('packages/customization/src/sandbox-loader.mjs', root).href,
  ];
  const environment = { NORTH_STAR_SANDBOX_WALL_CLOCK_MS: String(wallClock) };
  const child = (options.launch ?? defaultLaunch)(path, execArgv, environment);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cancel();
      action();
    };
    const cancel = (options.startTimer ?? defaultTimer)(wallClock, () => {
      child.kill('SIGKILL');
      settle(() => {
        reject(
          new SandboxFailure(
            'SANDBOX_TIMED_OUT',
            kind === 'verifyWorkflowDraft'
              ? 'The workflow draft took too long to verify.'
              : `the isolated compile did not finish within ${String(wallClock)} ms`,
          ),
        );
      });
    });
    child.once('message', (message: unknown) => {
      settle(() => {
        child.kill('SIGKILL');
        if (
          typeof message !== 'object' ||
          message === null ||
          (message as { protocol?: unknown }).protocol !==
            SANDBOX_PROTOCOL_VERSION
        ) {
          reject(
            new SandboxFailure(
              'SANDBOX_PROTOCOL_INVALID',
              'the sandbox answered outside its protocol',
            ),
          );
          return;
        }
        const answer = message as {
          environmentRefusal?: string;
          response?: unknown;
        };
        if (answer.environmentRefusal) {
          reject(
            new SandboxFailure(
              'SANDBOX_REFUSED_ENVIRONMENT',
              answer.environmentRefusal,
            ),
          );
          return;
        }
        if (!answer.response) {
          reject(
            new SandboxFailure(
              'SANDBOX_PROTOCOL_INVALID',
              'the sandbox sent no response',
            ),
          );
          return;
        }
        try {
          resolve(parse(answer.response));
        } catch (error) {
          reject(error);
        }
      });
    });
    child.once('exit', (code, signal) => {
      settle(() => {
        reject(
          new SandboxFailure(
            'SANDBOX_CRASHED',
            `the isolated ${kind} exited before answering (${String(code ?? signal)})`,
          ),
        );
      });
    });
    child.once('error', (error) => {
      settle(() => {
        reject(new SandboxFailure('SANDBOX_CRASHED', error.message));
      });
    });
    child.send({ protocol: SANDBOX_PROTOCOL_VERSION, kind, request });
  });
}

function defaultLaunch(
  path: string,
  execArgv: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcess {
  return fork(path, [], {
    env: environment,
    execArgv: [...execArgv],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

function defaultTimer(milliseconds: number, onExpiry: () => void) {
  const handle = setTimeout(onExpiry, milliseconds);
  return () => {
    clearTimeout(handle);
  };
}

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
  'northstar.customization-sandbox/v1' as const;
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

const workerPath = fileURLToPath(
  new URL('./sandbox-worker.ts', import.meta.url),
);

export async function compileInSandbox(
  request: SandboxRequest,
  options: SandboxRunnerOptions = {},
): Promise<SandboxResponse> {
  const heap =
    options.heapLimitMegabytes ?? SANDBOX_DEFAULT_LIMITS.heapLimitMegabytes;
  const wallClock =
    options.wallClockLimitMilliseconds ??
    SANDBOX_DEFAULT_LIMITS.wallClockLimitMilliseconds;
  const execArgv = [`--max-old-space-size=${String(heap)}`, '--import', 'tsx'];
  const environment = {
    ...process.env,
    NORTH_STAR_SANDBOX_WALL_CLOCK_MS: String(wallClock),
  };
  const child = (options.launch ?? defaultLaunch)(
    workerPath,
    execArgv,
    environment,
  );
  return new Promise<SandboxResponse>((resolve, reject) => {
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
            `the isolated compile did not finish within ${String(wallClock)} ms`,
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
              'the isolated compile answered outside its protocol',
            ),
          );
          return;
        }
        const answer = message as {
          environmentRefusal?: string;
          response?: SandboxResponse;
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
              'the isolated compile sent no response',
            ),
          );
          return;
        }
        resolve(answer.response);
      });
    });
    child.once('exit', (code, signal) => {
      settle(() => {
        reject(
          new SandboxFailure(
            'SANDBOX_CRASHED',
            `the isolated compile exited before answering (${String(code ?? signal)})`,
          ),
        );
      });
    });
    child.once('error', (error) => {
      settle(() => {
        reject(new SandboxFailure('SANDBOX_CRASHED', error.message));
      });
    });
    child.send({ protocol: SANDBOX_PROTOCOL_VERSION, request });
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

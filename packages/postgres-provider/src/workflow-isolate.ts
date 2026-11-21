import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { canonicalize } from '@north-star/canonical-model';

export const MAXIMUM_WORKFLOW_SOURCE_BYTES = 1024 * 1024;
export const MAXIMUM_WORKFLOW_EFFECT_BYTES = 16 * 1024;
export const MAXIMUM_WORKFLOW_EFFECTS = 64;
export const MAXIMUM_WORKFLOW_REPLAY_BYTES = 128 * 1024;

export interface WorkflowReplayEntry {
  readonly request: string;
  readonly result: string;
}

export type WorkflowIsolateOutcome =
  | {
      readonly kind: 'execution-failed' | 'invalid-call' | 'cpu-limit';
    }
  | { readonly kind: 'done'; readonly sites?: readonly number[] }
  | { readonly kind: 'call'; readonly request: string }
  | {
      readonly kind: 'changed-request' | 'unconsumed-prefix';
      readonly cursor: number;
    };

export class WorkflowWatchdogExpired extends Error {
  constructor() {
    super('Workflow isolate watchdog expired');
  }
}

export interface WorkflowIsolateOptions {
  readonly cpuMs?: number;
  readonly traceMethods?: readonly string[];
  /** The supervisor arms this timer when the worker is ready to evaluate. */
  readonly startWatchdog?: (expire: () => void) => () => void;
}

export async function runWorkflowIsolate(
  executable: string,
  input: string,
  options: WorkflowIsolateOptions = {},
): Promise<WorkflowIsolateOutcome> {
  if (Buffer.byteLength(input) > MAXIMUM_WORKFLOW_REPLAY_BYTES) {
    throw new Error('Workflow replay exceeds the byte limit');
  }
  if (Buffer.byteLength(executable) > MAXIMUM_WORKFLOW_SOURCE_BYTES) {
    throw new Error('Workflow executable exceeds the byte limit');
  }
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(
    new URL(`./workflow-isolate-worker.${extension}`, import.meta.url),
    {
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
      workerData: {
        traceMethods: options.traceMethods,
        cpuMs: options.cpuMs ?? 100,
        // Compiled workers start independently of the application's resolver.
        engine:
          typeof import.meta.resolve === 'function'
            ? import.meta.resolve('quickjs-emscripten')
            : pathToFileURL(
                createRequire(import.meta.url).resolve('quickjs-emscripten'),
              ).href,
        executable,
        input,
        maximumCallBytes: MAXIMUM_WORKFLOW_EFFECT_BYTES,
      },
    },
  );

  let cancelWatchdog: (() => void) | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<WorkflowIsolateOutcome>((resolve, reject) => {
      startupTimer = setTimeout(
        () => reject(new Error('Workflow isolate startup expired')),
        5_000,
      );
      worker.on(
        'message',
        (message: { kind: 'ready' } | { kind: 'outcome'; outcome: string }) => {
          try {
            if (message.kind === 'ready' && !cancelWatchdog) {
              clearTimeout(startupTimer);
              cancelWatchdog = (options.startWatchdog ?? startWatchdog)(() =>
                reject(new WorkflowWatchdogExpired()),
              );
            } else if (message.kind === 'outcome' && cancelWatchdog) {
              resolve(JSON.parse(message.outcome) as WorkflowIsolateOutcome);
            } else {
              reject(new Error('Unexpected workflow isolate response'));
            }
          } catch (error) {
            reject(error);
          }
        },
      );
      worker.once('error', reject);
      worker.once('exit', (code) =>
        reject(
          new Error(`Workflow isolate exited without an outcome (${code})`),
        ),
      );
    });
  } finally {
    clearTimeout(startupTimer);
    cancelWatchdog?.();
    await worker.terminate();
  }
}

function startWatchdog(expire: () => void): () => void {
  const timer = setTimeout(expire, 500);
  return () => clearTimeout(timer);
}

export function decodeWorkflowRequest(request: string): unknown {
  if (Buffer.byteLength(request) > MAXIMUM_WORKFLOW_EFFECT_BYTES)
    throw new Error('Workflow request exceeds the byte limit');
  const value: unknown = JSON.parse(request);
  if (canonicalize(value) !== request)
    throw new Error('Workflow request is not canonical JSON');
  return value;
}

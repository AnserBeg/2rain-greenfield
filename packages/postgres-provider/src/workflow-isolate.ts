import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  canonicalize,
  WorkflowHostCallSchema,
  type GoodsReceiptWorkflowEvent,
  type WorkflowHostCall,
} from '@north-star/canonical-model';
import type { CompiledWorkflow } from '@north-star/compiler';
import type { ImmutableJsonValue } from '@north-star/runtime/request-runtime-view';

export const WORKFLOW_MAXIMUM_EFFECTS = 64;
export const WORKFLOW_MAXIMUM_EFFECT_BYTES = 16 * 1024;

export interface WorkflowJournalEntry {
  readonly call: WorkflowHostCall;
  readonly result: ImmutableJsonValue;
}

export type WorkflowStep = { readonly kind: 'done' } | { readonly kind: 'call'; readonly call: WorkflowHostCall };

export async function runWorkflowStep(
  workflow: CompiledWorkflow,
  event: GoodsReceiptWorkflowEvent,
  journal: readonly WorkflowJournalEntry[],
  limits = { cpuMs: 100, watchdogMs: 5_000 },
): Promise<WorkflowStep> {
  if (journal.length > WORKFLOW_MAXIMUM_EFFECTS) throw new Error('Workflow effect limit exceeded');
  const replay = canonicalize({ event, journal });
  if (Buffer.byteLength(replay, 'utf8') > 128 * 1024) throw new Error('Workflow journal byte limit exceeded');
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL(`workflow-isolate-worker.${extension}`, import.meta.url), {
    workerData: {
      cpuMs: limits.cpuMs,
      engine: typeof import.meta.resolve === 'function'
        ? import.meta.resolve('quickjs-emscripten')
        : pathToFileURL(createRequire(import.meta.url).resolve('quickjs-emscripten')).href,
      executable: workflow.executable,
      maximumCallBytes: WORKFLOW_MAXIMUM_EFFECT_BYTES,
      replay,
    },
    resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const result = await new Promise<{ kind: 'done' } | { kind: 'call'; call: string }>((resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('Workflow isolate watchdog expired')), limits.watchdogMs);
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`Workflow isolate exited without a result (${code})`)));
  }).finally(async () => {
    clearTimeout(watchdog);
    await worker.terminate();
  });
  if (result.kind === 'done') return result;
  if (journal.length === WORKFLOW_MAXIMUM_EFFECTS) throw new Error('Workflow effect limit exceeded');
  const call = WorkflowHostCallSchema.parse(JSON.parse(result.call));
  assertWorkflowGrant(workflow, call);
  return { kind: 'call', call };
}

export function assertWorkflowGrant(workflow: CompiledWorkflow, call: WorkflowHostCall): void {
  if (call.kind === 'query' && !workflow.grants.queries.includes(call.id)) {
    throw new Error(`Workflow query grant refused: ${call.id}`);
  }
  if (call.kind === 'operation' && !workflow.grants.operations.includes(call.id)) {
    throw new Error(`Workflow operation grant refused: ${call.id}`);
  }
}

export async function verifyWorkflowReplay(workflow: CompiledWorkflow): Promise<void> {
  for (const { event, effects } of workflow.tests) {
    const journal: WorkflowJournalEntry[] = [];
    for (const effect of effects) {
      const actual = await runWorkflowStep(workflow, event, journal);
      if (actual.kind !== 'call' || canonicalize(actual.call) !== canonicalize(effect.call)) {
        throw new Error(`Workflow ${workflow.workflowId} disagrees with fixture effect ${journal.length + 1}`);
      }
      journal.push(effect);
    }
    for (let run = 0; run < 2; run++) {
      if ((await runWorkflowStep(workflow, event, journal)).kind !== 'done') {
        throw new Error(`Workflow ${workflow.workflowId} attempted an unmocked effect`);
      }
    }
  }
}

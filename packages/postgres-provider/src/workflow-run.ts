import { canonicalize, canonicalizeAndHash } from '@north-star/canonical-model';
import type { ImmutableJsonValue } from '@north-star/runtime/request-runtime-view';

import type { CompiledWorkflow } from './workflow-compile.js';
import {
  decodeWorkflowRequest,
  MAXIMUM_WORKFLOW_EFFECT_BYTES,
  MAXIMUM_WORKFLOW_EFFECTS,
  MAXIMUM_WORKFLOW_REPLAY_BYTES,
  runWorkflowIsolate,
  type WorkflowIsolateOptions,
  type WorkflowReplayEntry,
} from './workflow-isolate.js';
import type { WorkflowCall, WorkflowEvent } from './workflow-sdk.js';

export class WorkflowGuestError extends Error {
  override readonly name = 'WorkflowGuestError';
}

type WorkflowTerminal =
  | { readonly kind: 'done' }
  | {
      readonly kind: 'quarantined';
      readonly reason: 'changed-request' | 'unconsumed-prefix';
      readonly cursor: number;
    };

export type WorkflowStep =
  | WorkflowTerminal
  | {
      readonly kind: 'call';
      readonly cursor: number;
      readonly call: WorkflowCall;
    };

export interface WorkflowJournalSnapshot {
  readonly binding: string;
  readonly prefix: readonly WorkflowReplayEntry[];
  readonly pending: string | null;
  readonly terminal: WorkflowTerminal | null;
}

/** The supervisor owns this journal. A guest can propose an effect only. */
export class InMemoryWorkflowRun {
  readonly #binding: string;
  readonly #event: WorkflowEvent;
  readonly #prefix: WorkflowReplayEntry[];
  #pending: string | null;
  #terminal: WorkflowTerminal | null;
  #stepping: Promise<WorkflowStep> | undefined;

  constructor(
    private readonly workflow: CompiledWorkflow,
    event: WorkflowEvent,
    snapshot?: WorkflowJournalSnapshot,
    private readonly options: WorkflowIsolateOptions = {},
  ) {
    this.#event = Object.freeze({ ...event });
    this.#binding = canonicalizeAndHash({
      event: this.#event,
      release: workflow.sdk.release,
      declarations: workflow.sdk.declarations,
      executable: workflow.executable,
    }).contentHash;
    if (snapshot && snapshot.binding !== this.#binding)
      throw new Error('Workflow journal pin mismatch');

    this.#prefix = (snapshot?.prefix ?? []).map(({ request, result }) => ({
      request,
      result,
    }));
    this.#pending = snapshot?.pending ?? null;
    this.#terminal = snapshot?.terminal
      ? Object.freeze({ ...snapshot.terminal })
      : null;
    if (
      this.#prefix.length + Number(this.#pending !== null) >
      MAXIMUM_WORKFLOW_EFFECTS
    ) {
      throw new WorkflowGuestError('Workflow journal exceeds the effect limit');
    }
    if (this.#terminal && this.#pending !== null)
      throw new Error('Terminal workflow has a pending request');
    this.#assertReplaySize(this.#prefix, this.#pending);
    for (const { request, result } of this.#prefix) {
      this.#admit(request);
      if (encodeResult(JSON.parse(result) as ImmutableJsonValue) !== result) {
        throw new Error('Workflow result is not canonical JSON');
      }
    }
    if (this.#pending !== null) this.#admit(this.#pending);
  }

  snapshot(): WorkflowJournalSnapshot {
    return {
      binding: this.#binding,
      prefix: this.#prefix.map((entry) => ({ ...entry })),
      pending: this.#pending,
      terminal: this.#terminal,
    };
  }

  async step(): Promise<WorkflowStep> {
    if (this.#terminal) return this.#terminal;
    if (this.#pending !== null) return this.#pendingStep();
    if (!this.#stepping) {
      this.#stepping = this.#attempt().finally(() => {
        this.#stepping = undefined;
      });
    }
    return this.#stepping;
  }

  recordResult(
    effect: Extract<WorkflowStep, { kind: 'call' }>,
    result: ImmutableJsonValue,
  ): void {
    const { cursor, call } = effect;
    const request = canonicalize(call);
    const encoded = encodeResult(result);
    const completed = this.#prefix[cursor];
    if (completed?.request === request && completed.result === encoded) return;
    if (
      this.#terminal ||
      cursor !== this.#prefix.length ||
      this.#pending !== request
    ) {
      throw new Error('Workflow result does not match a pending effect');
    }
    const entry = { request, result: encoded };
    this.#assertReplaySize([...this.#prefix, entry], null);
    this.#prefix.push(entry);
    this.#pending = null;
  }

  async #attempt(): Promise<WorkflowStep> {
    const outcome = await runWorkflowIsolate(
      this.workflow.executable,
      canonicalize({ event: this.#event, prefix: this.#prefix }),
      this.options,
    );
    switch (outcome.kind) {
      case 'done':
        this.#terminal = Object.freeze({ kind: 'done' });
        return this.#terminal;
      case 'changed-request':
      case 'unconsumed-prefix':
        this.#terminal = Object.freeze({
          kind: 'quarantined',
          reason: outcome.kind,
          cursor: outcome.cursor,
        });
        return this.#terminal;
      case 'call': {
        if (this.#prefix.length === MAXIMUM_WORKFLOW_EFFECTS)
          throw new WorkflowGuestError('Workflow effect limit exceeded');
        const call = this.#admit(outcome.request);
        this.#assertReplaySize(this.#prefix, outcome.request);
        this.#pending = outcome.request;
        return { kind: 'call', cursor: this.#prefix.length, call };
      }
      case 'invalid-call':
        throw new WorkflowGuestError(
          'Workflow made an invalid or repeated call',
        );
      case 'cpu-limit':
        throw new WorkflowGuestError('Workflow isolate CPU limit exceeded');
      case 'execution-failed':
        throw new WorkflowGuestError('Workflow guest execution failed');
    }
  }

  #pendingStep(): WorkflowStep {
    return {
      kind: 'call',
      cursor: this.#prefix.length,
      call: this.#admit(this.#pending!),
    };
  }

  #admit(encoded: string): WorkflowCall {
    try {
      return this.workflow.sdk.admitCall(decodeWorkflowRequest(encoded));
    } catch (error) {
      throw new WorkflowGuestError(
        error instanceof Error
          ? error.message
          : 'Workflow guest call was refused',
        { cause: error },
      );
    }
  }

  #assertReplaySize(
    prefix: readonly WorkflowReplayEntry[],
    pending: string | null,
  ): void {
    if (
      Buffer.byteLength(canonicalize({ event: this.#event, prefix, pending })) >
      MAXIMUM_WORKFLOW_REPLAY_BYTES
    ) {
      throw new WorkflowGuestError(
        'Workflow journal exceeds the replay byte limit',
      );
    }
  }
}

function encodeResult(result: ImmutableJsonValue): string {
  const encoded = canonicalize(result);
  if (Buffer.byteLength(encoded) > MAXIMUM_WORKFLOW_EFFECT_BYTES)
    throw new Error('Workflow result exceeds the byte limit');
  return encoded;
}

export interface WorkflowVerificationFixture {
  readonly event: WorkflowEvent;
  readonly effects: readonly {
    readonly call: WorkflowCall;
    readonly result: ImmutableJsonValue;
  }[];
}

export async function verifyWorkflowReplay(
  workflow: CompiledWorkflow,
  fixtures: readonly WorkflowVerificationFixture[],
) {
  const journals = [];
  if (!fixtures.length)
    throw new Error('Workflow verification requires a fixture');
  for (const { event, effects } of fixtures) {
    const first = new InMemoryWorkflowRun(workflow, event);
    let cursor = 0;
    for (;;) {
      const step = await first.step();
      if (step.kind === 'quarantined')
        throw new Error(`Workflow replay diverged at cursor ${step.cursor}`);
      if (step.kind === 'done') break;
      const mock = effects[cursor];
      if (!mock)
        throw new Error(
          `Workflow attempted an unmocked call at cursor ${cursor}`,
        );
      if (canonicalize(step.call) !== canonicalize(mock.call)) {
        throw new Error(
          `Workflow call differs from the mock at cursor ${cursor}`,
        );
      }
      first.recordResult(step, mock.result);
      cursor++;
    }
    if (cursor !== effects.length)
      throw new Error(`Workflow left a mock unused at cursor ${cursor}`);
    const recorded = first.snapshot();
    journals.push(recorded.prefix);
    const replay = new InMemoryWorkflowRun(workflow, event, {
      ...recorded,
      terminal: null,
    });
    const step = await replay.step();
    if (step.kind !== 'done')
      throw new Error(
        `Workflow replay failed at cursor ${step.cursor} (${step.kind})`,
      );
  }
  return journals;
}

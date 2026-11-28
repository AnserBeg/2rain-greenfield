import type { WorkflowDefinition } from '../../canonical-model/src/schemas.js';
import { workflowTriggerReaderFloor } from '../../canonical-model/src/workflow-trigger-events.js';
import { hashCanonical } from './hash.js';

type CatalogEntry = Record<string, unknown>;

export class WorkflowGrantBindingError extends Error {
  constructor(readonly grantId: string | null) {
    super(
      grantId
        ? `Workflow grant does not resolve: ${grantId}`
        : 'Workflow SDK catalog missing',
    );
  }
}

function selectGrants(
  payload: unknown,
  collection: 'operations' | 'queries',
  ids: readonly string[],
) {
  const values = (payload as Record<string, unknown> | null)?.[collection];
  if (!Array.isArray(values)) throw new WorkflowGrantBindingError(null);
  const idKey = collection === 'operations' ? 'operationId' : 'queryId';
  return ids.map((id) => {
    const entry = (values as CatalogEntry[]).find(
      (candidate) =>
        candidate[idKey] === id && candidate.lifecycle === 'active',
    );
    if (
      !entry ||
      (collection === 'operations' &&
        (entry.tier !== 'o0' || !entry.inputContract)) ||
      (collection === 'queries' && entry.readModel)
    )
      throw new WorkflowGrantBindingError(id);
    return entry;
  });
}

export class WorkflowTriggerBindingError extends Error {
  constructor(
    readonly recordTypeId: string,
    /** The machine or state that refused, when the type itself resolved. */
    readonly subject: string = recordTypeId,
    readonly rule: string = 'Workflow trigger names a stored record type with one owning company.',
  ) {
    super(
      subject === recordTypeId
        ? `Workflow trigger record type does not resolve: ${recordTypeId}`
        : `Workflow trigger does not resolve on ${recordTypeId}: ${subject}`,
    );
  }
}

/**
 * ADR-0073 A1 admission for general members: the record type is a stored
 * entity of the release with exactly one owning company per record, because a
 * run needs a company scope, and the release creates it through an active
 * create operation, whose governed writer records each creation. A type that
 * only a writer without that guarantee creates (a projection, a ledger row, a
 * provisioned lock) fails closed. Returns whether any general member is
 * declared.
 */
export function workflowTriggerRecordTypes(
  storagePayload: unknown,
  operationsPayload: unknown,
): ReadonlySet<string> {
  const entities = (storagePayload as { entities?: unknown } | null)?.entities;
  const operations = (operationsPayload as { operations?: unknown } | null)
    ?.operations;
  const created = new Set(
    (Array.isArray(operations) ? (operations as CatalogEntry[]) : [])
      .filter(
        (operation) =>
          operation.lifecycle === 'active' &&
          (operation.effect as { kind?: unknown } | undefined)?.kind ===
            'createRecordEffect',
      )
      .map(
        (operation) =>
          (operation.effect as { entity?: { targetId?: unknown } }).entity
            ?.targetId,
      ),
  );
  return new Set(
    (Array.isArray(entities) ? (entities as CatalogEntry[]) : [])
      .filter(
        (entity) =>
          entity.lifecycle === 'active' &&
          entity.storageClass === 'dedicatedTable' &&
          (entity.legalEntity as { nullable?: unknown } | undefined)
            ?.nullable === false &&
          created.has(entity.entityId),
      )
      .map((entity) => String(entity.entityId)),
  );
}

interface MachineSource {
  readonly stateMachines?: readonly {
    readonly entity: { readonly targetId: string };
    readonly lifecycle?: string;
    readonly machineId: string;
    readonly stateField?: { readonly fieldId: string };
    readonly states: readonly {
      readonly stateId: string;
      readonly label: string;
    }[];
    readonly transitions: readonly {
      readonly transitionId: string;
      readonly fromState: { readonly targetId: string };
      readonly toState: { readonly targetId: string };
    }[];
  }[];
  readonly operations?: readonly {
    readonly lifecycle?: string;
    readonly effect: {
      readonly kind: string;
      readonly transition?: { readonly targetId: string };
    };
    /**
     * A declared block that writes a header's state outside the generic
     * transition writer (DOCUMENT-POSTING: the engine's definer moves the
     * header from `state.from` to `state.to`).
     */
    readonly documentPosting?:
      | {
          readonly header?: { readonly entity?: string | undefined };
          readonly state?: { readonly field?: string | undefined };
        }
      | undefined;
  }[];
}

/**
 * Amendment 10 (DOCUMENT-POSTING, TRAIN-AA): the record types and state fields
 * an active operation's declared block moves outside the generic transition
 * writer. Such a move is not a declared transition, so "every transition is
 * generic" cannot see it; the machine is refused here instead.
 */
function blockMovedMachines(revision: MachineSource): {
  readonly entities: ReadonlySet<string>;
  readonly stateFields: ReadonlySet<string>;
} {
  const entities = new Set<string>();
  const stateFields = new Set<string>();
  for (const operation of revision.operations ?? []) {
    if (operation.lifecycle === 'retired' || !operation.documentPosting)
      continue;
    const { header, state } = operation.documentPosting;
    if (header?.entity) entities.add(header.entity);
    if (state?.field) stateFields.add(state.field);
  }
  return { entities, stateFields };
}

function isBlockMoved(
  machine: NonNullable<MachineSource['stateMachines']>[number],
  moved: ReturnType<typeof blockMovedMachines>,
): boolean {
  return (
    moved.entities.has(machine.entity.targetId) ||
    (machine.stateField !== undefined &&
      moved.stateFields.has(machine.stateField.fieldId))
  );
}

/**
 * ADR-0073 A1 recordTransitioned, WORKFLOW-3 s1 (orchestrator ruling Q3,
 * 2026-11-28). Only the generic transition writer names a transition, so a
 * machine is admissible only when EVERY declared transition is performed by an
 * active generic transition operation. A machine with any other edge is moved
 * by some other writer (the purchase and sales order lifecycles are moved by
 * capability executors: test/architecture/record-state-writers.test.ts), and a
 * workflow on it would silently miss those moves, so it is refused by name.
 * A machine whose header an operation's declared block moves (a document
 * posting's ready -> posted, amendment 10) is refused for the same reason.
 * Returns, per admissible machine's record type, the states an admitted
 * transition ends in and the states each is entered from.
 */
export function workflowTransitionTargets(revision: MachineSource): ReadonlyMap<
  string,
  {
    readonly machineId: string;
    readonly states: ReadonlyMap<
      string,
      { readonly label: string; readonly fromStateIds: readonly string[] }
    >;
  }
> {
  const generic = new Set(
    (revision.operations ?? [])
      .filter(
        (operation) =>
          operation.lifecycle !== 'retired' &&
          operation.effect.kind === 'transitionStateEffect',
      )
      .map((operation) => operation.effect.transition?.targetId),
  );
  const moved = blockMovedMachines(revision);
  const result = new Map<
    string,
    {
      machineId: string;
      states: Map<string, { label: string; fromStateIds: string[] }>;
    }
  >();
  for (const machine of revision.stateMachines ?? []) {
    if (machine.lifecycle === 'retired') continue;
    if (isBlockMoved(machine, moved)) continue;
    if (
      machine.transitions.length === 0 ||
      !machine.transitions.every(({ transitionId }) =>
        generic.has(transitionId),
      )
    )
      continue;
    const labels = new Map(
      machine.states.map(({ stateId, label }) => [stateId, label]),
    );
    const states = new Map<string, { label: string; fromStateIds: string[] }>();
    for (const transition of machine.transitions) {
      const to = transition.toState.targetId;
      const entry = states.get(to) ?? {
        label: labels.get(to) ?? to,
        fromStateIds: [],
      };
      if (!entry.fromStateIds.includes(transition.fromState.targetId))
        entry.fromStateIds.push(transition.fromState.targetId);
      states.set(to, entry);
    }
    result.set(machine.entity.targetId, {
      machineId: machine.machineId,
      states,
    });
  }
  return result;
}

export function assertWorkflowTriggers(
  workflows: readonly WorkflowDefinition[],
  storagePayload: unknown,
  operationsPayload: unknown,
  revision: MachineSource = {},
): number {
  const admitted = workflowTriggerRecordTypes(
    storagePayload,
    operationsPayload,
  );
  const transitions = workflowTransitionTargets(revision);
  for (const { trigger } of workflows) {
    if (typeof trigger === 'string') continue;
    if (!admitted.has(trigger.recordTypeId))
      throw new WorkflowTriggerBindingError(trigger.recordTypeId);
    if (trigger.kind !== 'recordTransitioned') continue;
    const target = transitions.get(trigger.recordTypeId);
    if (!target) {
      const machine = (revision.stateMachines ?? []).find(
        (candidate) =>
          candidate.lifecycle !== 'retired' &&
          candidate.entity.targetId === trigger.recordTypeId,
      );
      throw new WorkflowTriggerBindingError(
        trigger.recordTypeId,
        machine?.machineId ?? trigger.recordTypeId,
        !machine
          ? 'Workflow trigger record type declares no state machine.'
          : isBlockMoved(machine, blockMovedMachines(revision))
            ? 'Workflow trigger machine is moved by a declared operation block (a document posting), so another writer moves it.'
            : 'Workflow trigger machine has a transition no generic transition operation performs, so another writer moves it.',
      );
    }
    const state = target.states.get(trigger.toStateId);
    if (!state)
      throw new WorkflowTriggerBindingError(
        trigger.recordTypeId,
        trigger.toStateId,
        'Workflow trigger state is not entered by an admitted transition.',
      );
    if (
      trigger.fromStateId !== undefined &&
      !state.fromStateIds.includes(trigger.fromStateId)
    )
      throw new WorkflowTriggerBindingError(
        trigger.recordTypeId,
        trigger.fromStateId,
        'Workflow trigger from-state has no admitted transition into its state.',
      );
  }
  return workflowTriggerReaderFloor(workflows.map(({ trigger }) => trigger));
}

export function workflowSdkBindingDigest(
  grants: WorkflowDefinition['grants'],
  operations: unknown,
  queries: unknown,
): string {
  return hashCanonical('northstar.workflow-sdk-binding/v1', {
    operations: selectGrants(operations, 'operations', grants.operations),
    queries: selectGrants(queries, 'queries', grants.queries),
  }).digest;
}

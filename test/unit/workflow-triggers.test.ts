import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalize } from '@north-star/canonical-model';

import * as customization from '../../packages/customization/src/index.js';
import { workflowPromptSection } from '../../packages/customization/src/ai-draft.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import {
  WORKFLOW_TRIGGER_MEMBERS,
  WorkflowDefinitionSchema,
  workflowTriggerMember,
  type WorkflowTriggerMember,
} from '../../packages/canonical-model/src/schemas.js';
import {
  WORKFLOW_TRIGGER_EVENT_FIELDS,
  WORKFLOW_TRIGGER_READER,
  WorkflowFixtureEventSchema,
  fixtureEventMatchesTrigger,
  workflowEventDeclaration,
  workflowTriggerDrafterLines,
  workflowTriggerReaderFloor,
} from '../../packages/canonical-model/src/workflow-trigger-events.js';
import {
  ENGINE_FACT_TRIGGER_READER,
  RECORD_CREATED_TRIGGER_READER,
  RECORD_TRANSITIONED_TRIGGER_READER,
} from '../../packages/canonical-model/src/workflows.js';
import {
  BOOKING_COMMITMENT_STATE_FACT,
  BOOKING_COMMITMENT_VALUES,
} from '../../packages/canonical-model/src/booking.js';
import {
  assertWorkflowTriggers,
  workflowEngineFactTargets,
  workflowTransitionTargets,
} from '../../packages/compiler/src/workflows.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import {
  occurrenceMatchesDefinition,
  recordStartSkip,
  workflowTriggerSource,
} from '../../packages/postgres-provider/src/workflow-consumer.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { replayCustomizationPatches } from '../../packages/customization/src/upgrade-replay.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  NOTE,
  NS as OPEN_ITEM_NS,
  compileOpenItems,
  openItemAuthored,
} from '../helpers/open-item-fixture.js';
import {
  BUILD_CASES,
  RECORD_TEMPLATE_CASES,
  WORKFLOW_TRANSITION_CASES,
  WORKFLOW_TRIGGER_CASES,
  type BuildCase,
} from '../agent/build-eval-cases.js';

type Json = Record<string, unknown>;
const file = 'apps/web/release/app.authored.json';
const base: Json = JSON.parse(readFileSync(file, 'utf8'));
const tip = parseCompiledApplication(
  JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
).application;
const acknowledgement = readUnboundPermissionAcknowledgementFor(
  file,
  'northstar.app:package.application',
);
const id = (s: string) => 'northstar.app:' + s;
const patch = (input: unknown) =>
  customization.CustomizationPatchSchema.parse(input);
function applied(source: Json, changes: readonly unknown[]): Json {
  const result = customization.applyCustomizationPatches(
    source,
    changes.map(patch),
  );
  assert.ok(result.status === 'applied', JSON.stringify(result));
  return result.authored;
}
const appointment = id('entity.custom_appointment');
const clinic = applied(base, [
  {
    kind: 'addRecordType',
    label: 'Appointment',
    companyOwnership: 'entityOwned',
    fields: [{ label: 'Name', type: 'text' }],
  },
]);
const recordCreated = {
  kind: 'recordCreated',
  triggerVersion: 'v1',
  recordTypeId: appointment,
} as const;
const save = (trigger: unknown) => ({
  kind: 'saveWorkflow',
  workflow: {
    schemaVersion: 'v6',
    workflowId: 'appointment-follow-up',
    trigger,
    bodyDigest: 'a'.repeat(64),
    grants: { queries: [], operations: [] },
  },
});

/**
 * Rule 12, fail closed. Every trigger member sits inside the one saveWorkflow
 * patch kind, so the patch-kind gate alone would miss a member. Each member
 * needs a generated drafter line, a fixture event whose keys are its declared
 * event fields, and a scored eval case (or a dated, named exception here).
 */
const TRIGGER_EVAL_EXCEPTIONS: Readonly<
  Partial<Record<WorkflowTriggerMember, { since: string; owner: string }>>
> = Object.freeze({
  // No eval base can declare an engine binding: Customize cannot add a
  // Booking operation, and the first-party release has none. EF01 scores the
  // unsupported side on the plain base; a positive case is owed with an eval
  // base that serves a Booking release.
  engineFactChanged: { since: '2026-11-28', owner: 'WORKFLOW-3 s1b' },
});
test('every workflow trigger member has generated drafter text, fixtures and an eval case', () => {
  const members = Object.keys(
    WORKFLOW_TRIGGER_MEMBERS,
  ) as WorkflowTriggerMember[];
  assert.deepEqual(
    members.sort(),
    Object.keys(WORKFLOW_TRIGGER_EVENT_FIELDS).sort(),
  );
  const lines = workflowTriggerDrafterLines([appointment]).join('\n');
  const prompt = workflowPromptSection(
    'declare const sdk: unknown;',
    [],
    [appointment],
  );
  assert.ok(
    lines.includes('"recordTransitioned"') &&
      lines.includes('kind:"recordTransitioned"'),
  );
  const fixtures = WorkflowFixtureEventSchema.options;
  const cases: readonly BuildCase[] = [
    ...BUILD_CASES,
    ...WORKFLOW_TRIGGER_CASES,
    ...WORKFLOW_TRANSITION_CASES,
  ];
  for (const member of members) {
    assert.ok(lines.includes(`"${member}"`), `${member} has a drafter line`);
    assert.ok(prompt.includes(`"${member}"`), `${member} reaches the prompt`);
    const fixture = fixtures.find(
      (option) => option.shape.type.value === member,
    );
    assert.ok(fixture, `${member} has a fixture event`);
    assert.deepEqual(
      Object.keys(fixture.shape)
        .filter((key) => key !== 'type')
        .sort(),
      [...WORKFLOW_TRIGGER_EVENT_FIELDS[member]].sort(),
      `${member} fixture keys are its declared event fields`,
    );
    const scored = cases.some(
      (c) =>
        c.expect.outcome === 'workflow' &&
        (c.expect.triggerMember ?? 'goodsReceiptPosted') === member &&
        (member === 'goodsReceiptPosted') === (c.expect.trigger === undefined),
    );
    assert.ok(
      scored || TRIGGER_EVAL_EXCEPTIONS[member],
      `${member} has an eval case or a dated exception`,
    );
  }
});

test('the receipt member keeps its bytes, declaration and persisted source', () => {
  const receipt = WorkflowDefinitionSchema.parse(
    save('goodsReceiptPosted').workflow,
  );
  assert.equal(
    canonicalize(receipt),
    canonicalize(save('goodsReceiptPosted').workflow),
  );
  assert.equal(
    workflowEventDeclaration('goodsReceiptPosted'),
    "type ReceiptEvent = Readonly<{ type: 'goodsReceiptPosted'; eventId: string; receiptId: string; legalEntityId: string }>;",
  );
  assert.deepEqual(workflowTriggerSource('goodsReceiptPosted'), {
    eventType: 'northstar.purchasing:event.receipt_posted',
    recordType: null,
    toState: null,
    fromState: null,
    factId: null,
  });
  const general = WorkflowDefinitionSchema.parse(save(recordCreated).workflow);
  assert.equal(workflowTriggerMember(general.trigger), 'recordCreated');
  assert.deepEqual(workflowTriggerSource(general.trigger), {
    eventType: 'northstar.runtime:event.record-created',
    recordType: appointment,
    toState: null,
    fromState: null,
    factId: null,
  });
  // B4 at the SDK: the recordCreated declaration keeps its exact bytes.
  assert.equal(
    workflowEventDeclaration(general.trigger),
    "type TriggerEvent = Readonly<{ type: 'recordCreated'; eventId: string; recordTypeId: 'northstar.app:entity.custom_appointment'; recordId: string; legalEntityId: string }>;",
  );
  assert.match(
    workflowEventDeclaration(general.trigger),
    /recordTypeId: 'northstar\.app:entity\.custom_appointment'; recordId: string/u,
  );
  // Strict, add-only members: an unknown key or a later version is refused.
  for (const trigger of [
    { ...recordCreated, label: 'Appointment' },
    { ...recordCreated, triggerVersion: 'v2' },
    { kind: 'recordCreated', triggerVersion: 'v1' },
  ])
    assert.throws(() => WorkflowDefinitionSchema.parse(save(trigger).workflow));
});

test('a recordCreated workflow compiles at its reader rung, and only on a company-owned stored type', async () => {
  const compiled = await customization.compileInSandbox({
    acknowledgement,
    base: clinic,
    chain: [patch(save(recordCreated))],
    tip: customization.serializeRelease(tip),
  });
  assert.ok(compiled.status === 'compiled', JSON.stringify(compiled));
  const release = customization.parseSerializedRelease(
    compiled.steps.at(-1)!.release as Parameters<
      typeof customization.parseSerializedRelease
    >[0],
  );
  const surface = release.compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  )!;
  assert.equal(
    surface.requiredRuntimeCapability.minimumVersion,
    RECORD_CREATED_TRIGGER_READER,
  );
  const receiptSurface = tip.compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  )!;
  assert.ok(
    receiptSurface.requiredRuntimeCapability.minimumVersion <
      RECORD_CREATED_TRIGGER_READER,
    'the first-party release, receipt workflows included, does not need the general-trigger reader',
  );
  // A shared master has no single owning company per record; a company-owned
  // ledger row has no create operation, so no governed writer records it.
  for (const recordTypeId of [
    id('entity.item'),
    id('entity.inventory_movement'),
  ]) {
    const refused = await customization.compileInSandbox({
      acknowledgement,
      base: clinic,
      chain: [patch(save({ ...recordCreated, recordTypeId }))],
      tip: customization.serializeRelease(tip),
    });
    assert.notEqual(refused.status, 'compiled', recordTypeId);
    assert.match(
      JSON.stringify(refused),
      new RegExp(recordTypeId.replaceAll('.', '\\.'), 'u'),
    );
  }
});

test('recordCreated replays clean over a label rename and names a retired record type', () => {
  const renamed = structuredClone(clinic);
  const entities = renamed.entities as Json[];
  const target = entities.find((e) => e.entityId === appointment)!;
  target.label = 'Visit';
  const origin = [{ parent: clinic, differentBase: true, patchId: 'saved' }];
  const clean = replayCustomizationPatches(
    renamed,
    [patch(save(recordCreated))],
    origin,
  );
  assert.notEqual(clean.status, 'replayConflict', JSON.stringify(clean));
  const retired = structuredClone(clinic);
  (retired.entities as Json[]).find(
    (e) => e.entityId === appointment,
  )!.lifecycle = 'retired';
  const conflict = replayCustomizationPatches(
    retired,
    [patch(save(recordCreated))],
    origin,
  );
  assert.equal(conflict.status, 'replayConflict');
  assert.deepEqual(
    conflict.findings.map((f) => [f.code, f.subject]),
    [['RETIRED_TARGET', appointment]],
  );
});

test('each general-trigger eval case names a company-owned type its base creates', () => {
  for (const c of [...WORKFLOW_TRIGGER_CASES, ...WORKFLOW_TRANSITION_CASES]) {
    assert.ok(c.expect.outcome === 'workflow' && c.expect.trigger, c.id);
    const targets = customization.customizationTargets(
      normalizeApplicationPackage(applied(base, c.base ?? [])),
    );
    const type = id(`entity.${c.expect.trigger}`);
    assert.ok(
      targets.linkTargets?.some((t) => t.entityId === type && t.companyOwned),
      `${c.id} names ${type}`,
    );
    for (const operation of c.expect.operations)
      assert.ok(
        JSON.stringify(targets).includes(id(`operation.${operation}`)),
        `${c.id} grants ${operation}`,
      );
  }
});

test('eval case ids are unique across every set build-eval-run loads', () => {
  const ids = [
    ...BUILD_CASES,
    ...RECORD_TEMPLATE_CASES,
    ...WORKFLOW_TRIGGER_CASES,
    ...WORKFLOW_TRANSITION_CASES,
  ].map((c) => c.id);
  assert.deepEqual(
    ids.filter((value, index) => ids.indexOf(value) !== index),
    [],
  );
});

test('a run never restarts its own workflow and a chain stops after depth three', () => {
  const person = { cause_workflow_id: null, cause_depth: null };
  assert.equal(recordStartSkip(person, 'a'), null);
  assert.equal(
    recordStartSkip({ cause_workflow_id: 'a', cause_depth: 0 }, 'a'),
    'self-caused',
  );
  assert.equal(
    recordStartSkip({ cause_workflow_id: 'c', cause_depth: 2 }, 'd'),
    null,
    'depth three still starts',
  );
  assert.equal(
    recordStartSkip({ cause_workflow_id: 'd', cause_depth: 3 }, 'e'),
    'depth-exceeded',
  );
});

// WORKFLOW-3 s1: the recordTransitioned member (ADR-0073 A1; orchestrator
// ruling Q3, 2026-11-28).
const inspection = id('entity.custom_inspection');
const state = (local: string) => id(`state.custom_inspection_${local}`);
const lifecycle = {
  kind: 'declareLifecycle',
  entity: inspection,
  initial: 'Scheduled',
  states: [
    { label: 'Scheduled' },
    { label: 'Passed' },
    { label: 'Failed' },
    { label: 'In progress' },
  ],
  transitions: [
    { label: 'Pass', from: 'Scheduled', to: 'Passed' },
    { label: 'Fail', from: 'Scheduled', to: 'Failed' },
    { label: 'Start', from: 'Scheduled', to: 'In progress' },
    { label: 'Abandon', from: 'In progress', to: 'Failed' },
  ],
};
const inspections = applied(clinic, [
  {
    kind: 'changeSet',
    patches: [
      {
        kind: 'addRecordType',
        label: 'Inspection',
        companyOwnership: 'entityOwned',
        fields: [{ label: 'Name', type: 'text' }],
      },
      lifecycle,
    ],
  },
]);
const failed = {
  kind: 'recordTransitioned',
  triggerVersion: 'v1',
  recordTypeId: inspection,
  toStateId: state('failed'),
  fromStateId: state('scheduled'),
} as const;
const compileOn = (source: Json, trigger: unknown) =>
  customization.compileInSandbox({
    acknowledgement,
    base: source,
    chain: [patch(save(trigger))],
    tip: customization.serializeRelease(tip),
  });

test('recordTransitioned is a strict member with its own event fields and declaration', () => {
  const general = WorkflowDefinitionSchema.parse(save(failed).workflow);
  assert.equal(workflowTriggerMember(general.trigger), 'recordTransitioned');
  assert.deepEqual(workflowTriggerSource(general.trigger), {
    eventType: 'northstar.runtime:event.record-transitioned',
    recordType: inspection,
    toState: state('failed'),
    fromState: state('scheduled'),
    factId: null,
  });
  assert.equal(
    workflowEventDeclaration(general.trigger),
    "type TriggerEvent = Readonly<{ type: 'recordTransitioned'; eventId: string; recordTypeId: 'northstar.app:entity.custom_inspection'; recordId: string; fromStateId: 'northstar.app:state.custom_inspection_scheduled'; toStateId: 'northstar.app:state.custom_inspection_failed'; legalEntityId: string }>;",
  );
  const anyFrom = {
    kind: 'recordTransitioned',
    triggerVersion: 'v1',
    recordTypeId: inspection,
    toStateId: state('failed'),
  } as const;
  assert.match(
    workflowEventDeclaration(
      WorkflowDefinitionSchema.parse(save(anyFrom).workflow).trigger,
    ),
    /fromStateId: string; toStateId: 'northstar\.app:state\.custom_inspection_failed'/u,
  );
  for (const trigger of [
    { ...failed, label: 'Failed' },
    { ...failed, triggerVersion: 'v2' },
    {
      kind: 'recordTransitioned',
      triggerVersion: 'v1',
      recordTypeId: inspection,
    },
  ])
    assert.throws(() => WorkflowDefinitionSchema.parse(save(trigger).workflow));
  const event = {
    type: 'recordTransitioned',
    recordTypeId: inspection,
    fromStateId: state('scheduled'),
    toStateId: state('failed'),
  };
  const parsed = WorkflowDefinitionSchema.parse(save(failed).workflow).trigger;
  const parsedAny = WorkflowDefinitionSchema.parse(
    save(anyFrom).workflow,
  ).trigger;
  assert.ok(fixtureEventMatchesTrigger(event, parsed));
  assert.ok(
    !fixtureEventMatchesTrigger(
      { ...event, toStateId: state('passed') },
      parsed,
    ),
    'a fixture into another state does not replay this trigger',
  );
  assert.ok(
    !fixtureEventMatchesTrigger(
      { ...event, fromStateId: state('in_progress') },
      parsed,
    ),
    'a fixture from another state does not replay a from-pinned trigger',
  );
  assert.ok(
    fixtureEventMatchesTrigger(
      { ...event, fromStateId: state('in_progress') },
      parsedAny,
    ),
  );
});

test('each member raises the reader floor to its own rung', () => {
  const parse = (trigger: unknown) =>
    WorkflowDefinitionSchema.parse(save(trigger).workflow).trigger;
  assert.deepEqual(Object.keys(WORKFLOW_TRIGGER_READER).sort(), [
    'engineFactChanged',
    'recordCreated',
    'recordTransitioned',
  ]);
  assert.equal(workflowTriggerReaderFloor(['goodsReceiptPosted']), 0);
  assert.equal(
    workflowTriggerReaderFloor([parse(recordCreated)]),
    RECORD_CREATED_TRIGGER_READER,
  );
  assert.equal(
    workflowTriggerReaderFloor([
      'goodsReceiptPosted',
      parse(recordCreated),
      parse(failed),
    ]),
    RECORD_TRANSITIONED_TRIGGER_READER,
    'a recordTransitioned release needs the recordTransitioned reader',
  );
  assert.ok(RECORD_TRANSITIONED_TRIGGER_READER > RECORD_CREATED_TRIGGER_READER);
});

test('a recordTransitioned workflow compiles at its own rung on a machine only generic operations move', async () => {
  const compiled = await compileOn(inspections, failed);
  assert.ok(compiled.status === 'compiled', JSON.stringify(compiled));
  const release = customization.parseSerializedRelease(
    compiled.steps.at(-1)!.release as Parameters<
      typeof customization.parseSerializedRelease
    >[0],
  );
  const surface = release.compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  )!;
  assert.equal(
    surface.requiredRuntimeCapability.minimumVersion,
    RECORD_TRANSITIONED_TRIGGER_READER,
    'the compiled floor is the recordTransitioned rung',
  );
});

test('recordTransitioned admission refuses by name what no generic writer alone moves', async () => {
  const refusedOn = async (source: Json, trigger: unknown, subject: string) => {
    const refused = await compileOn(source, trigger);
    assert.notEqual(refused.status, 'compiled', subject);
    assert.match(
      JSON.stringify(refused),
      new RegExp(subject.replaceAll('.', '\\.'), 'u'),
      `the refusal names ${subject}`,
    );
  };
  // Capability executors move the purchase order: refused by its machine.
  await refusedOn(
    inspections,
    {
      kind: 'recordTransitioned',
      triggerVersion: 'v1',
      recordTypeId: id('entity.purchase_order'),
      toStateId: id('state.purchase_order_closed'),
    },
    id('machine.purchase_order_lifecycle'),
  );
  // No admitted transition enters the initial state.
  await refusedOn(
    inspections,
    {
      kind: 'recordTransitioned',
      triggerVersion: 'v1',
      recordTypeId: inspection,
      toStateId: state('scheduled'),
    },
    state('scheduled'),
  );
  // No admitted transition goes from Passed to Failed.
  await refusedOn(
    inspections,
    { ...failed, fromStateId: state('passed') },
    state('passed'),
  );
  // A stored, company-owned, created type that declares no machine.
  await refusedOn(
    inspections,
    { ...failed, recordTypeId: appointment },
    appointment,
  );
});

test('only machines every transition of which a generic operation performs offer states', () => {
  const targets = workflowTransitionTargets(
    normalizeApplicationPackage(inspections) as Parameters<
      typeof workflowTransitionTargets
    >[0],
  );
  const offered = targets.get(inspection);
  assert.ok(offered, 'the tenant lifecycle is admissible');
  assert.deepEqual(
    [...offered.states.keys()].sort(),
    [state('failed'), state('in_progress'), state('passed')].sort(),
  );
  assert.deepEqual(offered.states.get(state('failed'))?.fromStateIds, [
    state('scheduled'),
    state('in_progress'),
  ]);
  assert.equal(
    targets.has(id('entity.purchase_order')),
    false,
    'a machine another writer moves offers no state',
  );
  assert.equal(
    targets.has(id('entity.sales_order')),
    false,
    'a machine another writer moves offers no state',
  );
  const lines = workflowTriggerDrafterLines(
    [inspection],
    [
      {
        recordTypeId: inspection,
        states: [...offered.states].map(([stateId, s]) => ({
          stateId,
          label: s.label,
          fromStateIds: s.fromStateIds,
        })),
      },
    ],
  ).join('\n');
  assert.match(lines, /custom_inspection_failed \("Failed"; from /u);
  assert.doesNotMatch(lines, /custom_inspection_scheduled \(/u);
});

test('an occurrence starts only the definitions its kind and states match', () => {
  const transitioned = 'northstar.runtime:event.record-transitioned';
  const created = 'northstar.runtime:event.record-created';
  const definition = {
    event_type: transitioned,
    record_type: inspection,
    to_state: state('failed'),
    from_state: state('scheduled'),
    fact_id: null,
  };
  const occurrence = {
    record_type: inspection,
    kind: 'transitioned',
    from_state: state('scheduled'),
    to_state: state('failed'),
  };
  assert.ok(occurrenceMatchesDefinition(occurrence, definition));
  assert.ok(
    !occurrenceMatchesDefinition(
      { ...occurrence, from_state: state('in_progress') },
      definition,
    ),
    'a move from another state does not match a from-pinned definition',
  );
  assert.ok(
    occurrenceMatchesDefinition(
      { ...occurrence, from_state: state('in_progress') },
      { ...definition, from_state: null },
    ),
  );
  assert.ok(
    !occurrenceMatchesDefinition(
      { ...occurrence, to_state: state('passed') },
      definition,
    ),
    'a move into another state does not match',
  );
  assert.ok(
    !occurrenceMatchesDefinition(
      {
        record_type: inspection,
        kind: 'created',
        from_state: null,
        to_state: null,
      },
      definition,
    ),
    'a creation does not start a transition workflow',
  );
  assert.ok(
    occurrenceMatchesDefinition(
      {
        record_type: inspection,
        kind: 'created',
        from_state: null,
        to_state: null,
      },
      {
        event_type: created,
        record_type: inspection,
        to_state: null,
        from_state: null,
        fact_id: null,
      },
    ),
  );
  assert.ok(
    !occurrenceMatchesDefinition(occurrence, {
      event_type: created,
      record_type: inspection,
      to_state: null,
      from_state: null,
      fact_id: null,
    }),
    'a transition does not start a creation workflow',
  );
});

test('recordTransitioned replays clean over a state label rename and names a retired record type', () => {
  const renamed = structuredClone(inspections);
  const machine = (renamed.stateMachines as Json[]).find(
    (m) => (m.entity as Json).targetId === inspection,
  )!;
  (machine.states as Json[]).find((s) => s.stateId === state('failed'))!.label =
    'Did not pass';
  const origin = [
    { parent: inspections, differentBase: true, patchId: 'saved' },
  ];
  const clean = replayCustomizationPatches(
    renamed,
    [patch(save(failed))],
    origin,
  );
  assert.notEqual(clean.status, 'replayConflict', JSON.stringify(clean));
  const retired = structuredClone(inspections);
  (retired.entities as Json[]).find(
    (e) => e.entityId === inspection,
  )!.lifecycle = 'retired';
  const conflict = replayCustomizationPatches(
    retired,
    [patch(save(failed))],
    origin,
  );
  assert.equal(conflict.status, 'replayConflict');
  assert.deepEqual(
    conflict.findings.map((f) => [f.code, f.subject]),
    [['RETIRED_TARGET', inspection]],
  );
});

test('each recordTransitioned eval case names a state an admitted transition enters', () => {
  for (const c of WORKFLOW_TRANSITION_CASES) {
    assert.ok(
      c.expect.outcome === 'workflow' && c.expect.trigger && c.expect.toState,
      c.id,
    );
    const offered = workflowTransitionTargets(
      normalizeApplicationPackage(applied(base, c.base ?? [])) as Parameters<
        typeof workflowTransitionTargets
      >[0],
    ).get(id(`entity.${c.expect.trigger}`));
    const target = offered?.states.get(id(`state.${c.expect.toState}`));
    assert.ok(target, `${c.id} names an admitted target state`);
    if (c.expect.fromState)
      assert.ok(
        target.fromStateIds.includes(id(`state.${c.expect.fromState}`)),
        `${c.id} names an admitted from-state`,
      );
  }
});

test('every reader-floor gate reads the per-member rung table (B6)', () => {
  for (const path of [
    'packages/compiler/src/workflows.ts',
    'packages/postgres-provider/src/release-verification-service.ts',
    'packages/postgres-provider/src/request-runtime-view-service.ts',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.match(
      source,
      /workflowTriggerReaderFloor\(/u,
      `${path} gates each member at its own rung`,
    );
    assert.doesNotMatch(
      source,
      /RECORD_CREATED_TRIGGER_READER/u,
      `${path} maps a member to one fixed rung`,
    );
  }
});

// ---- WORKFLOW-3 s1b: engineFactChanged ----

const rental = id('entity.custom_rental');
const fact = BOOKING_COMMITMENT_STATE_FACT;
const value = BOOKING_COMMITMENT_VALUES;
const confirmed = {
  kind: 'engineFactChanged',
  triggerVersion: 'v1',
  factId: fact,
  recordTypeId: rental,
  toValueId: value.confirmed,
} as const;
/** A revision whose one engine binding names `owner`, plus the storage and
 * operation catalogs the record-type rule reads. */
function engineRelease(owner: string, companyOwned = true) {
  const binding = {
    bindingVersion: 'booking.commitment/v1',
    declarationRevision: id('revision.bookable'),
    slotRevision: id('revision.slot'),
    slotId: id('slot.time'),
    resourceEntity: owner,
    ownerEntity: owner,
    ownerReadPermission: id('permission.read'),
    resourceReadPermission: id('permission.read'),
    operation: 'confirm',
    kind: 'unit',
    fulfilmentMode: 'tracked',
    maxBackdateDays: 1,
    holdSeconds: 900,
    unit: 'each',
    scale: 0,
  };
  return {
    revision: {
      operations: [
        {
          operationId: id('operation.confirm'),
          lifecycle: 'active',
          booking: binding,
          effect: { kind: 'registeredCapabilityEffect' },
        },
      ],
    },
    storage: {
      entities: [
        {
          entityId: owner,
          lifecycle: 'active',
          storageClass: 'dedicatedTable',
          ...(companyOwned ? { legalEntity: { nullable: false } } : {}),
        },
      ],
    },
    operations: {
      operations: [
        {
          lifecycle: 'active',
          effect: { kind: 'createRecordEffect', entity: { targetId: owner } },
        },
      ],
    },
  };
}
const admit = (trigger: unknown, release = engineRelease(rental)) =>
  assertWorkflowTriggers(
    [WorkflowDefinitionSchema.parse(save(trigger).workflow)],
    release.storage,
    release.operations,
    release.revision as never,
  );

test('engineFactChanged is a strict member with its own event fields and declaration', () => {
  const general = WorkflowDefinitionSchema.parse(save(confirmed).workflow);
  assert.equal(workflowTriggerMember(general.trigger), 'engineFactChanged');
  assert.deepEqual(workflowTriggerSource(general.trigger), {
    eventType: 'northstar.runtime:event.engine-fact-changed',
    recordType: rental,
    toState: value.confirmed,
    fromState: null,
    factId: fact,
  });
  assert.equal(
    workflowEventDeclaration(general.trigger),
    "type TriggerEvent = Readonly<{ type: 'engineFactChanged'; eventId: string; factId: 'northstar.booking:fact.commitment-state'; recordTypeId: 'northstar.app:entity.custom_rental'; recordId: string; subjectId: string; fromValueId: string; toValueId: 'northstar.booking:value.confirmed'; legalEntityId: string }>;",
  );
  for (const trigger of [
    { ...confirmed, label: 'Confirmed' },
    { ...confirmed, triggerVersion: 'v2' },
    { kind: 'engineFactChanged', triggerVersion: 'v1', recordTypeId: rental },
  ])
    assert.throws(() => WorkflowDefinitionSchema.parse(save(trigger).workflow));
  const event = {
    type: 'engineFactChanged',
    factId: fact,
    recordTypeId: rental,
    fromValueId: value.hold,
    toValueId: value.confirmed,
  };
  assert.ok(fixtureEventMatchesTrigger(event, general.trigger));
  assert.ok(
    !fixtureEventMatchesTrigger(
      { ...event, toValueId: value.cancelled },
      general.trigger,
    ),
  );
});

test('engineFactChanged admits only declared, command-entered values on a company-owned owner type', () => {
  for (const toValueId of [value.confirmed, value.inUse, value.returned])
    assert.equal(
      admit({ ...confirmed, toValueId }),
      ENGINE_FACT_TRIGGER_READER,
    );
  assert.equal(
    admit({ ...confirmed, toValueId: value.inUse, fromValueId: value.noShow }),
    ENGINE_FACT_TRIGGER_READER,
    'a recovered handover (no-show to in use) is a command move',
  );
  const refused = (trigger: unknown, subject: string, release?: never) =>
    assert.throws(
      () => admit(trigger, release),
      (error: Error & { subject?: string }) => error.subject === subject,
      subject,
    );
  // E3: a value any timer enters runs under an older release: refused by name.
  for (const toValueId of [value.cancelled, value.completed, value.noShow])
    refused({ ...confirmed, toValueId }, toValueId);
  refused(
    { ...confirmed, factId: id('fact.undeclared') },
    id('fact.undeclared'),
  );
  refused(
    { ...confirmed, toValueId: id('value.undeclared') },
    id('value.undeclared'),
  );
  refused({ ...confirmed, fromValueId: value.returned }, value.returned);
  refused({ ...confirmed, fromValueId: value.confirmed }, value.confirmed);
  // A shared owner (no company of its own) cannot be a trigger record.
  refused(confirmed, rental, engineRelease(rental, false) as never);
  // A stored, company-owned, created type no engine binding names.
  refused({ ...confirmed, recordTypeId: id('entity.custom_other') }, fact, {
    ...engineRelease(id('entity.custom_other')),
    revision: { operations: [] },
  } as never);
});

test('the drafter offers only the command-entered values an engine binding declares', () => {
  const targets = [
    ...workflowEngineFactTargets(engineRelease(rental).revision).values(),
  ];
  assert.equal(targets.length, 1);
  const offered = targets[0]!;
  assert.deepEqual(
    [...offered.values.keys()].sort(),
    [value.confirmed, value.inUse, value.returned].sort(),
    'the drafter offers exactly the command-entered values',
  );
  const lines = workflowTriggerDrafterLines(
    [rental],
    [],
    targets.map(({ factId, recordTypeId, values }) => ({
      factId,
      recordTypeId,
      values: [...values].map(([valueId, v]) => ({
        valueId,
        label: v.label,
        fromValueIds: v.fromValueIds,
      })),
    })),
  ).join('\n');
  assert.match(
    lines,
    /northstar\.booking:value\.confirmed \("Confirmed"; from /u,
  );
  assert.doesNotMatch(lines, /northstar\.booking:value\.cancelled \(/u);
  assert.match(
    workflowTriggerDrafterLines([]).join('\n'),
    /No engine fact in this release can start a workflow yet\./u,
  );
});

test('an engine fact starts only definitions of its own kind and fact (E4)', () => {
  const engineEvent = 'northstar.runtime:event.engine-fact-changed';
  const occurrence = {
    record_type: rental,
    kind: 'engineFact',
    from_state: value.hold,
    to_state: value.confirmed,
    fact_id: fact,
  };
  const definition = {
    event_type: engineEvent,
    record_type: rental,
    to_state: value.confirmed,
    from_state: null,
    fact_id: fact,
  };
  assert.ok(
    occurrenceMatchesDefinition(occurrence, definition),
    'a fact starts a definition of its own kind, fact and value',
  );
  assert.ok(
    !occurrenceMatchesDefinition(occurrence, {
      ...definition,
      fact_id: id('fact.other'),
    }),
    'another fact does not match',
  );
  assert.ok(
    !occurrenceMatchesDefinition(occurrence, {
      ...definition,
      event_type: 'northstar.runtime:event.record-transitioned',
      fact_id: null,
    }),
    'a fact does not start a recordTransitioned workflow on its owner type',
  );
  assert.ok(
    !occurrenceMatchesDefinition(
      { ...occurrence, kind: 'transitioned', fact_id: null },
      definition,
    ),
    'a record move into an equal ID does not start a fact workflow',
  );
  assert.ok(
    !occurrenceMatchesDefinition(
      {
        record_type: rental,
        kind: 'created',
        from_state: null,
        to_state: null,
        fact_id: null,
      },
      definition,
    ),
  );
});

test("Booking's SQL emit maps exactly the seven stored states to the declared values", () => {
  const states = /CHECK \(state IN \(([^)]*)\)\)/u
    .exec(
      readFileSync('db/migrations/0059_booking_fulfilment.sql', 'utf8'),
    )![1]!
    .split(',')
    .map((s) => s.trim().replaceAll("'", ''))
    .sort();
  assert.deepEqual(states, Object.keys(value).sort());
  const emit = readFileSync(
    'db/migrations/0078_booking_engine_facts.sql',
    'utf8',
  );
  const mapping =
    /'northstar\.booking:value\.' \|\| CASE state ([^]*?) END/u.exec(emit)![1]!;
  const mapped = (state: string) => {
    const hit = new RegExp(`WHEN '${state}' THEN '([a-z-]+)'`, 'u').exec(
      mapping,
    );
    return `northstar.booking:value.${hit ? hit[1] : state}`;
  };
  for (const state of states)
    assert.equal(
      mapped(state),
      value[state as keyof typeof value],
      `${state} maps to its declared value`,
    );
  assert.match(emit, new RegExp(`'${fact}'`, 'u'));
});

// TRAIN-Z (OPEN-ITEM-1 s1): the census classifies the open-item executor by
// reading only, because no recordTransitioned workflow can be admitted on an
// open item's machine: the core's issue is not a generic transition (and
// normalization refuses an active generic one), so admission refuses it.
test('a recordTransitioned workflow on an open item machine is refused at compile', () => {
  const workflow = (trigger: unknown) => ({
    schemaVersion: 'v6',
    workflowId: 'fee-note-follow-up',
    trigger,
    bodyDigest: 'a'.repeat(64),
    grants: { queries: [], operations: [] },
  });
  const compileWith = (trigger: unknown) => {
    const { authored, bindings } = openItemAuthored();
    return compileOpenItems(
      { ...authored, workflows: [workflow(trigger)] },
      bindings,
    );
  };
  const machine = `${OPEN_ITEM_NS}:machine.custom_fee_note`;
  const refused = compileWith({
    kind: 'recordTransitioned',
    triggerVersion: 'v1',
    recordTypeId: NOTE,
    toStateId: `${OPEN_ITEM_NS}:state.custom_fee_note_open`,
  });
  assert.notEqual(refused.status, 'compiled', 'an open item move was admitted');
  assert.match(
    JSON.stringify(refused),
    /Workflow trigger machine has a transition no generic transition operation performs/u,
    'the refusal is the generic-writer rule',
  );
  assert.match(
    JSON.stringify(refused),
    new RegExp(machine.replaceAll('.', '\\.'), 'u'),
    'the refusal names the open item machine',
  );
  // The same workflow on the same type's creations compiles, so the refusal
  // is the machine's, not the workflow's shape.
  const created = compileWith({
    kind: 'recordCreated',
    triggerVersion: 'v1',
    recordTypeId: NOTE,
  });
  assert.equal(
    created.status,
    'compiled',
    JSON.stringify(created.status === 'compiled' ? [] : created.diagnostics),
  );
});

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
  RECORD_CREATED_TRIGGER_READER,
  RECORD_TRANSITIONED_TRIGGER_READER,
} from '../../packages/canonical-model/src/workflows.js';
import { workflowTransitionTargets } from '../../packages/compiler/src/workflows.js';
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
> = Object.freeze({});
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
  });
  const general = WorkflowDefinitionSchema.parse(save(recordCreated).workflow);
  assert.equal(workflowTriggerMember(general.trigger), 'recordCreated');
  assert.deepEqual(workflowTriggerSource(general.trigger), {
    eventType: 'northstar.runtime:event.record-created',
    recordType: appointment,
    toState: null,
    fromState: null,
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
  });
  assert.equal(
    workflowEventDeclaration(general.trigger),
    "type TriggerEvent = Readonly<{ type: 'recordTransitioned'; eventId: string; recordTypeId: 'northstar.app:entity.custom_inspection'; recordId: string; fromStateId: 'northstar.app:state.custom_inspection_scheduled'; toStateId: 'northstar.app:state.custom_inspection_failed'; legalEntityId: string }>;",
  );
  const { fromStateId: _from, ...anyFrom } = failed;
  assert.match(
    workflowEventDeclaration(
      WorkflowDefinitionSchema.parse(save(anyFrom).workflow).trigger,
    ),
    /fromStateId: string; toStateId: 'northstar\.app:state\.custom_inspection_failed'/u,
  );
  for (const trigger of [
    { ...failed, label: 'Failed' },
    { ...failed, triggerVersion: 'v2' },
    { kind: 'recordTransitioned', triggerVersion: 'v1', recordTypeId: inspection },
  ])
    assert.throws(() => WorkflowDefinitionSchema.parse(save(trigger).workflow));
  const event = {
    type: 'recordTransitioned',
    recordTypeId: inspection,
    fromStateId: state('scheduled'),
    toStateId: state('failed'),
  };
  const parsed = WorkflowDefinitionSchema.parse(save(failed).workflow).trigger;
  const parsedAny = WorkflowDefinitionSchema.parse(save(anyFrom).workflow).trigger;
  assert.ok(fixtureEventMatchesTrigger(event, parsed));
  assert.ok(
    !fixtureEventMatchesTrigger({ ...event, toStateId: state('passed') }, parsed),
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
  assert.equal(WORKFLOW_TRIGGER_READER.goodsReceiptPosted, 0);
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
  assert.equal(targets.has(id('entity.purchase_order')), false);
  assert.equal(targets.has(id('entity.sales_order')), false);
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
  const definition = {
    record_type: inspection,
    to_state: state('failed'),
    from_state: state('scheduled'),
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
      { record_type: inspection, kind: 'created', from_state: null, to_state: null },
      definition,
    ),
    'a creation does not start a transition workflow',
  );
  assert.ok(
    occurrenceMatchesDefinition(
      { record_type: inspection, kind: 'created', from_state: null, to_state: null },
      { record_type: inspection, to_state: null, from_state: null },
    ),
  );
  assert.ok(
    !occurrenceMatchesDefinition(occurrence, {
      record_type: inspection,
      to_state: null,
      from_state: null,
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
  const origin = [{ parent: inspections, differentBase: true, patchId: 'saved' }];
  const clean = replayCustomizationPatches(renamed, [patch(save(failed))], origin);
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

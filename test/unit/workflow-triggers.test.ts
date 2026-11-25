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
  WorkflowFixtureEventSchema,
  workflowEventDeclaration,
  workflowTriggerDrafterLines,
} from '../../packages/canonical-model/src/workflow-trigger-events.js';
import { RECORD_CREATED_TRIGGER_READER } from '../../packages/canonical-model/src/workflows.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { workflowTriggerSource } from '../../packages/postgres-provider/src/workflow-consumer.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { replayCustomizationPatches } from '../../packages/customization/src/upgrade-replay.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  BUILD_CASES,
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
  const fixtures = WorkflowFixtureEventSchema.options;
  const cases: readonly BuildCase[] = [
    ...BUILD_CASES,
    ...WORKFLOW_TRIGGER_CASES,
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
        (member === 'goodsReceiptPosted'
          ? c.expect.trigger === undefined
          : c.expect.trigger !== undefined),
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
  });
  const general = WorkflowDefinitionSchema.parse(save(recordCreated).workflow);
  assert.equal(workflowTriggerMember(general.trigger), 'recordCreated');
  assert.deepEqual(workflowTriggerSource(general.trigger), {
    eventType: 'northstar.runtime:event.record-created',
    recordType: appointment,
  });
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
  // A shared first-party master has no single owning company per record.
  for (const recordTypeId of [id('entity.item')]) {
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

test('each recordCreated eval case names a company-owned type its base creates', () => {
  for (const c of WORKFLOW_TRIGGER_CASES) {
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

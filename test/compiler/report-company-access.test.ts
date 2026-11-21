import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPANY_ACCESS_INDEX,
  COMPANY_ACCESS_INDEX_READER,
} from '../../packages/canonical-model/src/index.js';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
  type StorageTransitionEnvelope,
} from '../../packages/compiler/src/index.js';
import {
  compileInSandbox,
  CustomizationPatchSchema,
  parseSerializedRelease,
  preparePatchForRecording,
  serializeRelease,
  storageElements,
} from '../../packages/customization/src/index.js';
import { projectionPayload } from './helpers.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';

import {
  compileReportFixture,
  reportsPredecessor,
} from '../helpers/reports-preceding-release.js';
const inspection = {
  kind: 'addRecordType',
  label: 'Inspection',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text' },
    { label: 'Outcome', type: 'choice', options: ['Pass', 'Fail'] },
  ],
};
const entityId = 'northstar.app:entity.custom_inspection';
const parse = (input: unknown) => CustomizationPatchSchema.parse(input);
const recording = (input: unknown) => preparePatchForRecording(parse(input));

test('recording a company-owned type binds its access path once, including in a change set', () => {
  const fresh = { ...inspection, companyAccessIndex: COMPANY_ACCESS_INDEX };
  assert.deepEqual(recording(inspection), fresh);
  assert.deepEqual(
    recording({
      kind: 'changeSet',
      patches: [inspection, { ...inspection, label: 'Visit' }],
    }),
    {
      kind: 'changeSet',
      patches: [fresh, { ...fresh, label: 'Visit' }],
    },
  );
  assert.deepEqual(parse(inspection), inspection);
  const shared = { ...inspection, companyOwnership: 'tenantShared' };
  assert.deepEqual(recording(shared), shared);
  assert.throws(
    () => parse({ ...shared, companyAccessIndex: COMPANY_ACCESS_INDEX }),
    /company ownership/iu,
  );
});

test('the new Inspection declares one named, same-plan secondary index and its own reader floor', async () => {
  const { compiled } = await compileReportFixture([recording(inspection)]);
  const target = projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const indexes = target.entities
    .find((e) => e.entityId === entityId)!
    .indexes.filter((i) => i.indexKind === 'reportAccess');
  assert.equal(indexes.length, 1);
  const [index] = indexes;
  assert.equal(
    index!.physicalName,
    'nsm_i_57kahsinwt3fo73cpq5mduuaqnwmyh6a7jjowaafqx5jvwtbwnsa',
  );
  assert.deepEqual(index!.columnNames, [
    'tenant_id',
    'environment_id',
    'legal_entity_id',
    'record_id',
  ]);
  const plan = projectionPayload<StorageTransitionEnvelope>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const elements = plan.elements.filter(
    (e) =>
      e.kind === 'createIndex' && e.physicalObjectName === index!.physicalName,
  );
  assert.equal(elements.length, 1);
  assert.equal(
    elements[0]!.classification.preparationValidity,
    'preApprovalInert',
  );
  const table = plan.elements.find(
    (e) => e.kind === 'createTable' && e.subjectId === entityId,
  );
  assert.ok(table);
  assert.deepEqual(elements[0]!.declaredDependencyIds, [table.elementId]);
  assert.equal(
    compiled.bundle.releaseManifest.projections.find(
      (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
    )?.requiredRuntimeCapability.minimumVersion,
    COMPANY_ACCESS_INDEX_READER,
  );
});

test('an archived pre-key company-owned Inspection reproduces every release byte, root and floor and adds zero indexes on replay', async () => {
  const chain = [
    parse(inspection),
    parse({
      kind: 'arrangeLayout',
      surface: 'northstar.app:surface.custom_inspection_list',
      relabel: [
        {
          field: 'northstar.app:field.custom_inspection_outcome',
          label: 'Result',
        },
      ],
    }),
  ];
  await withArchivedCustomizationRuntime(reportsPredecessor, async (run) => {
    const historical = (await run(
      `
      import { readFile } from 'node:fs/promises';
      import { readUnboundPermissionAcknowledgementFor } from './apps/web/scripts/unbound-permission-acknowledgement.ts';
      import { parseCompiledApplication } from './packages/postgres-provider/src/composed-application-runtime.ts';
      import { compileInSandbox, serializeRelease } from './packages/customization/src/index.ts';
      const path = 'apps/web/release/app.authored.json';
      const request = {
        acknowledgement: readUnboundPermissionAcknowledgementFor(path,'northstar.app:package.application'),
        base: JSON.parse(await readFile(path,'utf8')), chain: JSON.parse(await readFile(process.argv[2],'utf8')),
        tip: serializeRelease(parseCompiledApplication(JSON.parse(await readFile('apps/web/release/app.compiled.json','utf8'))).application),
      };
      const result = await compileInSandbox(request);
      if(result.status !== 'compiled') throw new Error(JSON.stringify(result));
      console.log(JSON.stringify({request,releases:result.steps.map(s => s.release)}));
    `,
      chain,
    )) as {
      request: Parameters<typeof compileInSandbox>[0];
      releases: ReturnType<typeof serializeRelease>[];
    };
    const current = await compileInSandbox(historical.request);
    assert.ok(
      current.status === 'compiled',
      current.status === 'compiled' ? '' : JSON.stringify(current),
    );
    for (const [i, step] of current.steps.entries()) {
      const prior = historical.releases[i]!;
      assert.equal(step.release.releaseRoot, prior.releaseRoot);
      assert.equal(
        step.release.normalizedDefinitionBytesBase64,
        prior.normalizedDefinitionBytesBase64,
      );
      assert.deepEqual(step.release, prior);
      const { compiled } = parseSerializedRelease(step.release);
      const target = projectionPayload<StorageTargetPayloadV1>(
        compiled,
        PROJECTION_FAMILY_IDS.storageTarget,
      );
      const type = target.entities.find((e) => e.entityId === entityId)!;
      assert.ok(type.legalEntity);
      assert.equal(
        type.indexes.filter((index) => index.indexKind === 'reportAccess')
          .length,
        0,
      );
      assert.ok(
        compiled.bundle.releaseManifest.projections.find(
          (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
        )!.requiredRuntimeCapability.minimumVersion <
          COMPANY_ACCESS_INDEX_READER,
      );
    }
    assert.deepEqual(
      storageElements(
        parseSerializedRelease(current.steps[1]!.release).compiled,
      ).filter((e) => e.kind === 'createIndex'),
      [],
    );
  });
});

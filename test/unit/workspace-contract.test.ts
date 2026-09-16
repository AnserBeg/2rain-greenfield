import assert from 'node:assert/strict';
import test from 'node:test';

import { platformContract } from '../../packages/canonical-model/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import {
  SurfaceDocumentEditorSchema,
  SurfaceWorkspaceSchema,
} from '../../packages/canonical-model/src/index.js';
import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import { legalEntityReadScopeRequirement } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';

test('the scaffold exposes a canonical workspace contract', () => {
  assert.deepEqual(platformContract, {
    authority: 'canonical-model',
    product: 'greenfield-north-star-erp',
  });
});

test('legal-entity read scope dispatches only from compiler-owned storage metadata', () => {
  type StorageEntity = StorageTargetPayloadV1['entities'][number];
  const syntheticEntityOwned = {
    entityId: 'northstar.synthetic:entity.unrelated_fact',
    legalEntity: {
      column: 'legal_entity_id',
      familyClassification: 'entityOwned',
      immutableAfterCreate: true,
      nullable: false,
      postgresqlType: 'uuid',
      referencedFamilyId: 'legal_entity',
    },
  } as unknown as StorageEntity;
  const syntheticTenantShared = {
    entityId: 'northstar.synthetic:entity.shared_reference',
  } as unknown as StorageEntity;

  assert.deepEqual(legalEntityReadScopeRequirement(syntheticEntityOwned), {
    column: 'legal_entity_id',
    kind: 'legalEntity',
  });
  assert.equal(legalEntityReadScopeRequirement(syntheticTenantShared), null);
});

test('workspace declarations preserve contextual surfaces and support an unrelated document editor', () => {
  const authored = JSON.parse(
    JSON.stringify(composedApplicationDefinition())
      .replaceAll('northstar.app', 'northstar.servicefixture')
      .replaceAll('sales_order', 'service_request'),
  );
  const model = normalizeApplicationPackage(authored);
  const workspace = model.surfaces.find(
    (value) =>
      value.surfaceId ===
      'northstar.servicefixture:surface.service_request_list',
  )!;
  assert.equal(
    SurfaceWorkspaceSchema.parse(
      'workspace' in workspace && workspace.workspace,
    ).membership,
    'operational',
  );
  const line = model.surfaces.find(
    (value) =>
      value.surfaceId ===
      'northstar.servicefixture:surface.service_request_line_list',
  )!;
  assert.equal(
    SurfaceWorkspaceSchema.parse('workspace' in line && line.workspace)
      .membership,
    'contextual',
  );
  const form = model.surfaces.find(
    (value) =>
      value.surfaceId ===
      'northstar.servicefixture:surface.service_request_form',
  )!;
  const editor = SurfaceDocumentEditorSchema.parse(
    'documentEditor' in form && form.documentEditor,
  );
  assert.equal(
    editor.recordSurfaceId,
    'northstar.servicefixture:surface.service_request_detail',
  );
  assert.equal(editor.saveMode, 'sequential');
});

test('canonical workspace/editor declarations refuse wrong ownership, undeclared references and atomic claims', () => {
  const source = composedApplicationDefinition();
  const mutate = (change: (surface: Record<string, unknown>) => void) => {
    const candidate = structuredClone(source);
    const surface = (candidate.surfaces as Record<string, unknown>[]).find(
      (value) => String(value.surfaceId).endsWith(':surface.sales_order_form'),
    )!;
    change(surface);
    assert.throws(() => normalizeApplicationPackage(candidate));
  };
  mutate((surface) => {
    (surface.documentEditor as Record<string, unknown>).parentRelationId =
      'northstar.app:relation.shipment_order';
  });
  mutate((surface) => {
    (surface.documentEditor as Record<string, unknown>).lineQueryId =
      'northstar.app:query.missing';
  });
  mutate((surface) => {
    (surface.documentEditor as Record<string, unknown>).saveMode = 'atomic';
  });
  mutate((surface) => {
    (surface.workspace as Record<string, unknown>).ownerSurfaceId =
      'northstar.app:surface.sales_order_line_list';
  });
});

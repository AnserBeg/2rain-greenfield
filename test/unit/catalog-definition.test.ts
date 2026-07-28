import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECTION_FAMILY_IDS,
  type StorageTransitionEnvelope,
} from '../../packages/compiler/src/index.js';
import {
  CATALOG_IDS,
  catalogModuleDefinition,
} from '../../packages/domain/src/catalog/index.js';
import {
  normalizeResolverText,
  rankResolverCandidates,
  resolverTextSimilarity,
} from '../../packages/runtime/src/resolve-by-name.js';
import type { SemanticRecordDto } from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  compileCatalogFixture,
  projectionPayload,
} from '../fixtures/g2/catalog/compiler.js';

test('Catalog definition compiles into every walking-slice projection with lifecycle but no inventory', () => {
  const first = compileCatalogFixture();
  const second = compileCatalogFixture();
  assert.equal(first.compiled.releaseRoot, second.compiled.releaseRoot);
  assert.deepEqual(
    first.compiled.bundle.releaseManifest,
    second.compiled.bundle.releaseManifest,
  );

  const definition = catalogModuleDefinition() as {
    assertions: Array<Record<string, unknown>>;
    entities: Array<Record<string, unknown>>;
    fields: Array<{
      fieldId: string;
      label: string;
      presence: 'optional' | 'required';
    }>;
    operations: Array<{ effect: { kind: string }; operationId: string }>;
    queries: Array<{
      queryId: string;
      queryType: string;
      resolveMatchKeys?: Array<{
        authority: 'advisory' | 'identifier';
        field: { targetId: string };
      }>;
    }>;
    relations: Array<Record<string, unknown>>;
    surfaces: Array<Record<string, unknown>>;
  };
  assert.equal(definition.entities.length, 1);
  assert.equal(definition.fields.length, 4);
  assert.equal(definition.queries.length, 4);
  assert.equal(definition.operations.length, 4);
  assert.equal(definition.surfaces.length, 3);
  assert.equal(definition.assertions.length, 1);
  assert.deepEqual(definition.relations, []);
  assert.deepEqual(
    new Set(definition.queries.map((query) => query.queryType)),
    new Set(['get', 'list', 'search', 'resolve']),
  );
  assert.deepEqual(
    definition.queries
      .find(
        (query) =>
          query.queryId === `${CATALOG_IDS.namespace}:query.item_resolve`,
      )
      ?.resolveMatchKeys?.map((key) => ({
        authority: key.authority,
        fieldId: key.field.targetId,
      })),
    [
      { authority: 'identifier', fieldId: CATALOG_IDS.fieldIds.sku },
      { authority: 'advisory', fieldId: CATALOG_IDS.fieldIds.name },
    ],
  );
  assert.deepEqual(
    definition.fields.map((field) => field.fieldId),
    [
      CATALOG_IDS.fieldIds.sku,
      CATALOG_IDS.fieldIds.name,
      CATALOG_IDS.fieldIds.description,
      CATALOG_IDS.fieldIds.baseUnit,
    ],
  );
  const baseUnit = definition.fields.find(
    (field) => field.fieldId === CATALOG_IDS.fieldIds.baseUnit,
  );
  assert.ok(baseUnit, 'Catalog base-unit descriptor is absent');
  assert.equal(baseUnit.label, 'Base unit');
  assert.equal(baseUnit.presence, 'required');
  assert.equal(
    JSON.stringify(definition.fields).match(/on[-_ ]?hand|quantity|stock/giu),
    null,
  );
  assert.equal(
    definition.operations.some((operation) =>
      /delete|purge|destroy/i.test(
        `${operation.operationId} ${operation.effect.kind}`,
      ),
    ),
    false,
  );
  assert.deepEqual(
    definition.operations.map((operation) => operation.effect.kind).sort(),
    [
      'archiveRecordEffect',
      'createRecordEffect',
      'restoreRecordEffect',
      'updateRecordEffect',
    ],
  );

  const familyIds = new Set(
    first.compiled.bundle.releaseManifest.projections.map(
      (projection) => projection.familyId,
    ),
  );
  for (const familyId of [
    PROJECTION_FAMILY_IDS.storageTarget,
    PROJECTION_FAMILY_IDS.storageTransition,
    PROJECTION_FAMILY_IDS.queryCatalog,
    PROJECTION_FAMILY_IDS.operationCatalog,
    PROJECTION_FAMILY_IDS.surfaceManifest,
    PROJECTION_FAMILY_IDS.agentDiscovery,
    PROJECTION_FAMILY_IDS.reporting,
    PROJECTION_FAMILY_IDS.verificationPlan,
  ]) {
    assert.equal(familyIds.has(familyId), true, familyId);
  }
  const transition = projectionPayload<StorageTransitionEnvelope>(
    first.compiled,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  assert.ok(transition.elements.length > 0);
  assert.equal(
    transition.elements.some((element) =>
      /delete|drop|truncate|destroy/i.test(element.kind),
    ),
    false,
  );
});

test('Catalog projections carry one item DTO field identity to query, surface, agent, and read-back', () => {
  const { compiled } = compileCatalogFixture();
  const expectedFields = [
    CATALOG_IDS.fieldIds.sku,
    CATALOG_IDS.fieldIds.name,
    CATALOG_IDS.fieldIds.description,
    CATALOG_IDS.fieldIds.baseUnit,
  ];
  const query = projectionPayload<{
    queries: Array<{
      queryId: string;
      resolveMatchKeys?: Array<{
        authority: 'advisory' | 'identifier';
        fieldId: string;
      }>;
      selections: Array<{ fieldId: string }>;
    }>;
  }>(compiled, PROJECTION_FAMILY_IDS.queryCatalog);
  const agent = projectionPayload<{
    operations: Array<{ operationId: string; readBackQueryId: string }>;
    queries: Array<{ fieldIds: string[]; queryId: string }>;
  }>(compiled, PROJECTION_FAMILY_IDS.agentDiscovery);
  const surfaces = projectionPayload<{
    surfaces: Array<{ fieldIds: string[]; surfaceId: string }>;
  }>(compiled, PROJECTION_FAMILY_IDS.surfaceManifest);
  assert.equal(query.queries.length, 4);
  assert.equal(agent.queries.length, 4);
  assert.equal(agent.operations.length, 4);
  assert.equal(surfaces.surfaces.length, 3);
  for (const queryDefinition of query.queries) {
    assert.deepEqual(
      queryDefinition.selections.map((selection) => selection.fieldId),
      expectedFields,
    );
    assert.deepEqual(
      agent.queries.find((entry) => entry.queryId === queryDefinition.queryId)
        ?.fieldIds,
      expectedFields,
    );
  }
  for (const surface of surfaces.surfaces) {
    assert.deepEqual(surface.fieldIds, expectedFields);
  }
  for (const operation of agent.operations) {
    assert.equal(
      operation.readBackQueryId,
      `${CATALOG_IDS.namespace}:query.item_get`,
    );
  }
});

test('Catalog name resolution primitives are deterministic and never choose a weak advisory name', () => {
  assert.equal(normalizeResolverText('  STEEL-Bolt__M8 '), 'steel bolt m8');
  assert.ok(
    resolverTextSimilarity('Galvanized Boltt', 'Galvanized Bolt') > 0.8,
  );
  const records = [
    dto('00000000-0000-4000-8000-000000000002', 'Galvanized Bolt'),
    dto('00000000-0000-4000-8000-000000000001', 'Galvanized Bolts'),
  ];
  const first = rankResolverCandidates(
    'Galvanized Boltt',
    records,
    [CATALOG_IDS.fieldIds.name],
    0.7,
  );
  const second = rankResolverCandidates(
    'Galvanized Boltt',
    [...records].reverse(),
    [CATALOG_IDS.fieldIds.name],
    0.7,
  );
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});

function dto(recordId: string, name: string): SemanticRecordDto {
  return {
    archived: false,
    entityId: CATALOG_IDS.entityIds.item,
    recordId,
    revision: 1,
    values: { [CATALOG_IDS.fieldIds.name]: name },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECTION_FAMILY_IDS,
  type StorageTransitionEnvelope,
} from '../../packages/compiler/src/index.js';
import {
  LOCATION_IDS,
  locationModuleDefinition,
} from '../../packages/domain/src/location/index.js';
import {
  normalizeResolverText,
  rankResolverCandidates,
  resolverTextSimilarity,
} from '../../packages/runtime/src/resolve-by-name.js';
import type { SemanticRecordDto } from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  compileLocationFixture,
  projectionPayload,
} from '../fixtures/g2/location/compiler.js';

test('Location definition compiles into every walking-slice projection with lifecycle but no inventory', () => {
  const first = compileLocationFixture();
  const second = compileLocationFixture();
  assert.equal(first.compiled.releaseRoot, second.compiled.releaseRoot);
  assert.deepEqual(
    first.compiled.bundle.releaseManifest,
    second.compiled.bundle.releaseManifest,
  );

  const definition = locationModuleDefinition() as {
    assertions: Array<Record<string, unknown>>;
    entities: Array<Record<string, unknown>>;
    languageVersion: string;
    fields: Array<{
      fieldId: string;
      fieldType: {
        kind: string;
        options?: Array<{ label: string; optionId: string }>;
      };
      label: string;
      presence: 'optional' | 'required';
    }>;
    capabilityRequirements: Array<{
      capabilityId: string;
      supportStatus: string;
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
  assert.equal(definition.fields.length, 3);
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
          query.queryId === `${LOCATION_IDS.namespace}:query.location_resolve`,
      )
      ?.resolveMatchKeys?.map((key) => ({
        authority: key.authority,
        fieldId: key.field.targetId,
      })),
    [
      { authority: 'identifier', fieldId: LOCATION_IDS.fieldIds.code },
      { authority: 'advisory', fieldId: LOCATION_IDS.fieldIds.name },
    ],
  );
  assert.deepEqual(
    definition.fields.map((field) => field.fieldId),
    [
      LOCATION_IDS.fieldIds.code,
      LOCATION_IDS.fieldIds.name,
      LOCATION_IDS.fieldIds.locationType,
    ],
  );
  const locationType = definition.fields.find(
    (field) => field.fieldId === LOCATION_IDS.fieldIds.locationType,
  );
  assert.ok(locationType, 'Location type descriptor is absent');
  assert.equal(locationType.label, 'Location type');
  assert.equal(locationType.presence, 'required');
  assert.equal(locationType.fieldType.kind, 'enumFieldType');
  // `schemaVersion` is derived from the definition under test, not written by
  // hand: node-version purity means every node in this package carries the
  // package's own version, so the fact under test is that these options are
  // NODES OF THIS PACKAGE -- which a literal states only by coincidence.
  assert.deepEqual(locationType.fieldType.options, [
    {
      kind: 'enumOption',
      label: 'Warehouse',
      optionId: `${LOCATION_IDS.namespace}:option.warehouse`,
      orderKey: 10,
      schemaVersion: definition.languageVersion,
    },
    {
      kind: 'enumOption',
      label: 'Store',
      optionId: `${LOCATION_IDS.namespace}:option.store`,
      orderKey: 20,
      schemaVersion: definition.languageVersion,
    },
  ]);
  assert.deepEqual(definition.capabilityRequirements, [
    {
      capabilityId: LOCATION_IDS.contentCapabilityId,
      capabilityVersion: 1,
      declaredEffects: ['read'],
      kind: 'capabilityRequirement',
      requiredProjections: [
        'storage',
        'policy',
        'query',
        'operation',
        'surface',
        'agent',
        'reporting',
        'verification',
      ],
      schemaVersion: definition.languageVersion,
      supportStatus: 'supported',
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(definition),
    /hierarch|parent[_ -]?location|location[_ -]?tree/i,
  );
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

test('Location projections carry one location DTO field identity to query, surface, agent, and read-back', () => {
  const { compiled } = compileLocationFixture();
  const expectedFields = [
    LOCATION_IDS.fieldIds.code,
    LOCATION_IDS.fieldIds.name,
    LOCATION_IDS.fieldIds.locationType,
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
      `${LOCATION_IDS.namespace}:query.location_get`,
    );
  }
});

test('Location name resolution primitives are deterministic and never choose a weak advisory name', () => {
  assert.equal(normalizeResolverText('  NORTH-Dock__01 '), 'north dock 01');
  assert.ok(resolverTextSimilarity('North Warehous', 'North Warehouse') > 0.8);
  const records = [
    dto('00000000-0000-4000-8000-000000000002', 'North Warehouse'),
    dto('00000000-0000-4000-8000-000000000001', 'North Warehouses'),
  ];
  const first = rankResolverCandidates(
    'North Warehous',
    records,
    [LOCATION_IDS.fieldIds.name],
    0.7,
  );
  const second = rankResolverCandidates(
    'North Warehous',
    [...records].reverse(),
    [LOCATION_IDS.fieldIds.name],
    0.7,
  );
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});

function dto(recordId: string, name: string): SemanticRecordDto {
  return {
    archived: false,
    entityId: LOCATION_IDS.entityIds.location,
    recordId,
    revision: 1,
    values: { [LOCATION_IDS.fieldIds.name]: name },
  };
}

test('LOCATIONS: the product mounts Location with an inventory status, the reason and time it changed and the widened types; the harness keeps its Location', () => {
  type Definition = {
    fields: Array<{
      fieldId: string;
      presence: string;
      defaultSemantics: string;
      defaultValue?: { value: string };
      fieldType: { kind: string; options?: Array<{ optionId: string }> };
    }>;
    queries: Array<{
      queryId: string;
      selections: Array<{ field: { targetId: string } }>;
    }>;
  };
  const ns = LOCATION_IDS.namespace;
  const plain = locationModuleDefinition() as unknown as Definition;
  const product = locationModuleDefinition(ns, {
    inventoryStatus: true,
  }) as unknown as Definition;
  const type = (definition: Definition) =>
    definition.fields
      .find((value) => value.fieldId === LOCATION_IDS.fieldIds.locationType)!
      .fieldType.options!.map((option) => option.optionId);
  // The harness compiles the Location it always has.
  assert.deepEqual(
    plain.fields.map((value) => value.fieldId),
    [
      LOCATION_IDS.fieldIds.code,
      LOCATION_IDS.fieldIds.name,
      LOCATION_IDS.fieldIds.locationType,
    ],
  );
  assert.deepEqual(type(plain), [
    `${ns}:option.warehouse`,
    `${ns}:option.store`,
  ]);
  // The product adds three fields and appends seven types.
  assert.deepEqual(
    product.fields.map((value) => value.fieldId),
    [
      LOCATION_IDS.fieldIds.code,
      LOCATION_IDS.fieldIds.name,
      LOCATION_IDS.fieldIds.locationType,
      LOCATION_IDS.fieldIds.status,
      LOCATION_IDS.fieldIds.statusReason,
      LOCATION_IDS.fieldIds.statusChangedAt,
    ],
  );
  assert.deepEqual(
    type(product),
    [
      'warehouse',
      'store',
      'location_type_storage',
      'location_type_receiving',
      'location_type_shipping',
      'location_type_quarantine',
      'location_type_in_transit',
      'location_type_scrap',
      'location_type_yard',
    ].map((local) => `${ns}:option.${local}`),
  );
  const status = product.fields.find(
    (value) => value.fieldId === LOCATION_IDS.fieldIds.status,
  )!;
  assert.equal(status.presence, 'optional');
  assert.equal(status.defaultSemantics, 'declaredDefault');
  assert.equal(status.defaultValue?.value, LOCATION_IDS.statusOptionIds.usable);
  assert.deepEqual(
    status.fieldType.options!.map((option) => option.optionId),
    Object.values({
      usable: LOCATION_IDS.statusOptionIds.usable,
      quarantine: LOCATION_IDS.statusOptionIds.quarantine,
      damaged: LOCATION_IDS.statusOptionIds.damaged,
      inTransit: LOCATION_IDS.statusOptionIds.inTransit,
      returnPending: LOCATION_IDS.statusOptionIds.returnPending,
    }),
  );
  // Every query reads them; all three are optional, so a create need not
  // state them.
  for (const query of product.queries)
    assert.equal(query.selections.length, 6, query.queryId);
  for (const fieldId of [
    LOCATION_IDS.fieldIds.status,
    LOCATION_IDS.fieldIds.statusReason,
    LOCATION_IDS.fieldIds.statusChangedAt,
  ])
    assert.equal(
      product.fields.find((value) => value.fieldId === fieldId)!.presence,
      'optional',
    );
});

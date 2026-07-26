import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
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
  assert.deepEqual(locationType.fieldType.options, [
    {
      kind: 'enumOption',
      label: 'Warehouse',
      optionId: `${LOCATION_IDS.namespace}:option.warehouse`,
      orderKey: 10,
      schemaVersion: 'v2',
    },
    {
      kind: 'enumOption',
      label: 'Store',
      optionId: `${LOCATION_IDS.namespace}:option.store`,
      orderKey: 20,
      schemaVersion: 'v2',
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
      schemaVersion: 'v2',
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

test('Location is definition-only and the generic production press has no Location branch', () => {
  const locationSources = sourceFiles('packages/domain/src/location');
  assert.ok(
    locationSources.length > 0,
    'Location definition sources are absent',
  );
  for (const file of locationSources) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /from\s+['"](?:pg|postgres|@north-star\/runtime|@north-star\/postgres-provider)/,
      `${relative(process.cwd(), file)} imports a runtime/provider`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
      `${relative(process.cwd(), file)} contains SQL`,
    );
    assert.doesNotMatch(
      source,
      /(?:class|function)\s+\w*(?:Handler|Executor|Gateway|Repository|Service)\b|React|route\s*\(/,
      `${relative(process.cwd(), file)} contains module glue`,
    );
  }
  const pressFiles = [
    ...sourceFiles('apps/web/src'),
    ...sourceFiles('packages/compiler'),
    ...sourceFiles('packages/canonical-model'),
    ...sourceFiles('packages/postgres-provider'),
    ...sourceFiles('packages/runtime'),
    ...sourceFiles('packages/platform-runtime'),
    ...sourceFiles('packages/dev-tooling'),
  ];
  assert.ok(pressFiles.length > 0, 'production press sources are absent');
  const genericPress = pressFiles
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    genericPress,
    /northstar\.location|location_(?:get|list|search|resolve|create|update|archive|restore)/,
  );
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

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (['.js', '.mjs', '.ts', '.tsx'].includes(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  walk(resolve(directory));
  return files.sort();
}

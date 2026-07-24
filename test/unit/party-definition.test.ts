import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import test from 'node:test';

import {
  PROJECTION_FAMILY_IDS,
  type StorageTransitionEnvelope,
} from '../../packages/compiler/src/index.js';
import {
  normalizeResolverText,
  rankResolverCandidates,
  resolverTextSimilarity,
} from '../../packages/runtime/src/resolve-by-name.js';
import type { SemanticRecordDto } from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  PARTY_IDS,
  partyModuleDefinition,
} from '../fixtures/g2/party/definition.js';
import {
  compilePartyFixture,
  projectionPayload,
} from '../fixtures/g2/party/compiler.js';

test('Party definition compiles into every walking-slice projection with no delete', () => {
  const first = compilePartyFixture();
  const second = compilePartyFixture();
  assert.equal(first.compiled.releaseRoot, second.compiled.releaseRoot);
  assert.deepEqual(
    first.compiled.bundle.releaseManifest,
    second.compiled.bundle.releaseManifest,
  );

  const definition = partyModuleDefinition() as {
    assertions: Array<Record<string, unknown>>;
    entities: Array<Record<string, unknown>>;
    operations: Array<{ effect: { kind: string }; operationId: string }>;
    languageVersion: string;
    normalizationProfileVersion: string;
    queries: Array<{
      queryId: string;
      queryType: string;
      resolveMatchKeys?: Array<{
        authority: 'advisory' | 'identifier';
        field: { targetId: string };
      }>;
      selections: Array<{ field: { targetId: string } }>;
    }>;
    relations: Array<Record<string, unknown>>;
    surfaces: Array<Record<string, unknown>>;
  };
  assert.equal(definition.entities.length, 2);
  assert.equal(definition.queries.length, 8);
  assert.equal(definition.operations.length, 8);
  assert.equal(definition.surfaces.length, 6);
  assert.equal(definition.assertions.length, 2);
  assert.equal(definition.relations.length, 1);
  assert.equal(definition.languageVersion, 'v2');
  assert.equal(
    definition.normalizationProfileVersion,
    'northstar.normalization/v2',
  );
  assert.deepEqual(
    new Set(definition.queries.map((query) => query.queryType)),
    new Set(['get', 'list', 'search', 'resolve']),
  );
  assert.deepEqual(
    definition.queries
      .find(
        (query) =>
          query.queryId === `${PARTY_IDS.namespace}:query.party_resolve`,
      )
      ?.resolveMatchKeys?.map((key) => ({
        authority: key.authority,
        fieldId: key.field.targetId,
      })),
    [
      { authority: 'identifier', fieldId: PARTY_IDS.fieldIds.number },
      { authority: 'advisory', fieldId: PARTY_IDS.fieldIds.name },
    ],
  );
  assert.equal(
    definition.operations.some((operation) =>
      /delete|purge|destroy/i.test(operation.effect.kind),
    ),
    false,
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
  assert.equal(transition.elements.length > 0, true);
  assert.equal(
    transition.elements.some((element) =>
      /delete|drop|truncate|destroy/i.test(element.kind),
    ),
    false,
  );
});

test('Party and role queries expose one DTO field identity to UI, query, agent and read-back', () => {
  const { compiled } = compilePartyFixture();
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
    surfaces: Array<{
      dataSourceQueryId: string;
      fieldIds: string[];
      surfaceId: string;
    }>;
  }>(compiled, PROJECTION_FAMILY_IDS.surfaceManifest);
  const partyFields = [
    PARTY_IDS.fieldIds.number,
    PARTY_IDS.fieldIds.name,
    PARTY_IDS.fieldIds.contactSummary,
  ];
  assert.deepEqual(
    query.queries
      .find(
        (entry) =>
          entry.queryId === `${PARTY_IDS.namespace}:query.party_resolve`,
      )
      ?.resolveMatchKeys?.map((key) => ({
        authority: key.authority,
        fieldId: key.fieldId,
      })),
    [
      { authority: 'identifier', fieldId: PARTY_IDS.fieldIds.number },
      { authority: 'advisory', fieldId: PARTY_IDS.fieldIds.name },
    ],
  );
  for (const queryDefinition of query.queries.filter((entry) =>
    entry.queryId.includes(':query.party_'),
  )) {
    if (queryDefinition.queryId.includes('party_role_')) continue;
    assert.deepEqual(
      queryDefinition.selections.map((selection) => selection.fieldId),
      partyFields,
    );
    assert.deepEqual(
      agent.queries.find((entry) => entry.queryId === queryDefinition.queryId)
        ?.fieldIds,
      partyFields,
    );
  }
  for (const surface of surfaces.surfaces.filter(
    (entry) => !entry.surfaceId.includes('party_role_'),
  )) {
    assert.deepEqual(surface.fieldIds, partyFields);
  }
  for (const operation of agent.operations.filter(
    (entry) =>
      entry.operationId.includes(':operation.party_') &&
      !entry.operationId.includes('party_role_'),
  )) {
    assert.equal(
      operation.readBackQueryId,
      `${PARTY_IDS.namespace}:query.party_get`,
    );
  }
});

test('ported generic text primitives are deterministic and never choose a weak name', () => {
  assert.equal(
    normalizeResolverText('  ACME-Réntals__Ltd. '),
    'acme rentals ltd',
  );
  assert.equal(
    resolverTextSimilarity('Maxmium Constructon', 'Maximum Construction') > 0.8,
    true,
  );
  const records = [
    dto('00000000-0000-4000-8000-000000000002', 'Maximum Construction'),
    dto('00000000-0000-4000-8000-000000000001', 'Maximum Constructors'),
  ];
  const first = rankResolverCandidates(
    'Maxmium Constructon',
    records,
    [PARTY_IDS.fieldIds.name],
    0.7,
  );
  const second = rankResolverCandidates(
    'Maxmium Constructon',
    [...records].reverse(),
    [PARTY_IDS.fieldIds.name],
    0.7,
  );
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});

test('Party is definition-only and generic production press has no Party branch', () => {
  for (const file of sourceFiles('packages/domain/src/party')) {
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
  const genericPress = [
    ...sourceFiles('apps/web/src'),
    ...sourceFiles('packages/postgres-provider/src'),
    ...sourceFiles('packages/runtime/src'),
  ]
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    genericPress,
    /northstar\.party|party_(?:get|list|search|resolve|create|update|archive|restore)/,
  );
});

function dto(recordId: string, name: string): SemanticRecordDto {
  return {
    archived: false,
    entityId: PARTY_IDS.entityIds.party,
    recordId,
    revision: 1,
    values: { [PARTY_IDS.fieldIds.name]: name },
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

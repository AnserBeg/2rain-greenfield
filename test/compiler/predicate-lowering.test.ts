import assert from 'node:assert/strict';
import test from 'node:test';

import { CanonicalModelError } from '../../packages/canonical-model/src/index.js';
import {
  PREDICATE_LOWERING_TABLE,
  PROJECTION_FAMILY_IDS,
} from '../../packages/compiler/src/index.js';
import type { PredicateLoweringPlan } from '../../packages/canonical-model/src/index.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/index.js';
import {
  compilePartyFixture,
  projectionPayload,
} from '../fixtures/g2/party/compiler.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';

const partyListQueryId = `${PARTY_IDS.namespace}:query.party_list`;
const partyFilteredListQueryId = `${PARTY_IDS.namespace}:query.party_filtered_list`;

test('q1 query filters lower through the closed cost-class table', () => {
  assert.deepEqual(PREDICATE_LOWERING_TABLE, [
    {
      costClass: 'indexedFoldedEquality',
      loweringRowId: 'northstar.predicate-lowering/folded-equality-v1',
      match: 'foldedEqualityWithDeclaredIndex',
      providerProbeId: 'Q1-P1/indexed-folded-equality',
    },
    {
      costClass: 'tenantBoundedScan',
      loweringRowId: 'northstar.predicate-lowering/tenant-scan-comparison-v1',
      match: 'remainingComparison',
      providerProbeId: 'Q1-P1/tenant-bounded-scan',
    },
  ]);

  const indexed = compiledListQuery(
    q1PartyDefinition(comparison('equals', PARTY_IDS.fieldIds.name, 'Alpha')),
  );
  assert.equal(indexed.filterPlan?.costClass, 'indexedFoldedEquality');
  assert.deepEqual(indexed.filterPlan?.root, {
    comparisonMode: 'unicodeCaseFold',
    costClass: 'indexedFoldedEquality',
    fieldId: PARTY_IDS.fieldIds.name,
    kind: 'fieldComparisonPredicate',
    loweringRowId: 'northstar.predicate-lowering/folded-equality-v1',
    operator: 'equals',
    value: { kind: 'textValue', schemaVersion: 'v2', value: 'Alpha' },
  });

  const bounded = compiledListQuery(
    q1PartyDefinition({
      kind: 'allPredicate',
      schemaVersion: 'v2',
      terms: [
        comparison('notEquals', PARTY_IDS.fieldIds.name, 'Alpha'),
        {
          kind: 'notPredicate',
          schemaVersion: 'v2',
          term: comparison('lessThan', PARTY_IDS.fieldIds.name, 'Zulu'),
        },
        {
          kind: 'anyPredicate',
          schemaVersion: 'v2',
          terms: [
            comparison('greaterThan', PARTY_IDS.fieldIds.name, 'Able'),
            { kind: 'booleanPredicate', schemaVersion: 'v2', value: false },
          ],
        },
      ],
    }),
  );
  assert.equal(bounded.filterPlan?.costClass, 'tenantBoundedScan');
  assert.equal(
    collectComparisonOperators(bounded.filterPlan!.root).sort().join(','),
    'greaterThan,lessThan,notEquals',
  );

  const binaryDefinition = q1PartyDefinition(
    comparison('equals', PARTY_IDS.fieldIds.contactSummary, 'case-sensitive'),
  ) as { fields: Array<Record<string, unknown>> } & Record<string, unknown>;
  const binaryField = binaryDefinition.fields.find(
    (field) => field.fieldId === PARTY_IDS.fieldIds.contactSummary,
  );
  assert.ok(binaryField);
  binaryField.collation = 'binary';
  const binary = compiledListQuery(binaryDefinition);
  assert.equal(binary.filterPlan?.root.kind, 'fieldComparisonPredicate');
  if (binary.filterPlan?.root.kind === 'fieldComparisonPredicate') {
    assert.equal(binary.filterPlan.root.comparisonMode, 'binary');
    assert.equal(binary.filterPlan.root.costClass, 'tenantBoundedScan');
  }

  const unchangedQ0 = compiledListQuery(
    legacyV2PartyDefinition(),
    partyListQueryId,
  );
  assert.equal(unchangedQ0.tier, 'q0');
  assert.equal(unchangedQ0.filterPlan, undefined);
});

test('operators and nodes outside the q1 lowering table fail before emission', () => {
  for (const operator of ['greaterThanOrEqual', 'lessThanOrEqual']) {
    assert.throws(
      () =>
        compilePartyFixture(
          q1PartyDefinition({
            ...comparison('lessThan', PARTY_IDS.fieldIds.name, 'Alpha'),
            operator,
          }),
        ),
      (error: unknown) => error instanceof CanonicalModelError,
    );
  }
  assert.throws(
    () =>
      compilePartyFixture(
        q1PartyDefinition({ kind: 'mysteryPredicate', schemaVersion: 'v2' }),
      ),
    (error: unknown) => error instanceof CanonicalModelError,
  );
});

interface CompiledQuery {
  readonly filterPlan?: PredicateLoweringPlan;
  readonly queryId: string;
  readonly tier: string;
}

function compiledListQuery(
  definition: Record<string, unknown>,
  queryId: string = partyFilteredListQueryId,
): CompiledQuery {
  const fixture = compilePartyFixture(definition);
  const payload = projectionPayload<{
    queries: CompiledQuery[];
  }>(fixture.compiled, PROJECTION_FAMILY_IDS.queryCatalog);
  const query = payload.queries.find(
    (candidate) => candidate.queryId === queryId,
  );
  assert.ok(query);
  return query;
}

function q1PartyDefinition(filter: unknown): Record<string, unknown> {
  const definition = legacyV2PartyDefinition() as {
    queries: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const query = definition.queries.find(
    (candidate) => candidate.queryId === partyListQueryId,
  );
  assert.ok(query);
  const filtered = structuredClone(query);
  filtered.queryId = partyFilteredListQueryId;
  filtered.tier = 'q1';
  filtered.filter = filter;
  filtered.selections = (
    filtered.selections as Array<Record<string, unknown>>
  ).map((selection, index) => ({
    ...selection,
    selectionId: `${PARTY_IDS.namespace}:selection.party_filtered_list_${String(index + 1)}`,
  }));
  definition.queries.push(filtered);
  return definition;
}

function legacyV2PartyDefinition(): Record<string, unknown> {
  const definition = replaceVersion(partyModuleDefinition(), 'v3', 'v2') as
    Record<string, unknown> | undefined;
  if (!definition) throw new TypeError('party definition is missing');
  delete definition.impactAnalyses;
  definition.normalizationProfileVersion = 'northstar.normalization/v2';
  return definition;
}

function replaceVersion(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceVersion(entry, from, to));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceVersion(entry, from, to),
      ]),
    );
  }
  return value;
}

function comparison(
  operator: 'equals' | 'greaterThan' | 'lessThan' | 'notEquals',
  fieldId: string,
  value: string,
): Record<string, unknown> {
  return {
    field: { kind: 'fieldReference', schemaVersion: 'v2', targetId: fieldId },
    kind: 'fieldComparisonPredicate',
    operator,
    schemaVersion: 'v2',
    value: { kind: 'textValue', schemaVersion: 'v2', value },
  };
}

function collectComparisonOperators(
  node: PredicateLoweringPlan['root'],
): string[] {
  switch (node.kind) {
    case 'booleanPredicate':
      return [];
    case 'fieldComparisonPredicate':
      return [node.operator];
    case 'notPredicate':
      return collectComparisonOperators(node.term);
    case 'allPredicate':
    case 'anyPredicate':
      return node.terms.flatMap(collectComparisonOperators);
  }
}

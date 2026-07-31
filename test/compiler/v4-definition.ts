import { LANGUAGE_VERSIONS } from '../../packages/canonical-model/src/index.js';
import { FIXTURE_IDS } from '../fixtures/g2/module-conformance/definitions.js';

import { V3_AGGREGATE_IDS, v3AggregateModule } from './v3-definition.js';

export const V4_SCOPE_IDS = Object.freeze({
  aggregateScopeParameter: `${FIXTURE_IDS.namespace}:parameter.aggregate_entity_scope`,
  rowQuery: `${FIXTURE_IDS.namespace}:query.master_list`,
  rowScopeParameter: `${FIXTURE_IDS.namespace}:parameter.row_entity_scope`,
});

type MutableModule = {
  queries: Array<Record<string, unknown>>;
} & Record<string, unknown>;

/**
 * The v3 aggregate fixture advanced to v4, with the legal-entity operand on
 * both query branches: `exactlyOne` on the aggregate, which is the `onHand`
 * shape, and `nonEmptySet` on an ordinary row query, which is ADR-0015's
 * consolidated-reporting shape.
 */
export function v4ScopedModule(): MutableModule {
  const definition = replaceVersion(
    v3AggregateModule(),
    LANGUAGE_VERSIONS.v3,
    LANGUAGE_VERSIONS.v4,
  ) as MutableModule;
  definition.normalizationProfileVersion =
    'northstar.normalization/v4' as const;

  const aggregate = requireQuery(definition, V3_AGGREGATE_IDS.aggregateQuery);
  (aggregate.parameters as Record<string, unknown>[]).push(
    parameterDefinition(V4_SCOPE_IDS.aggregateScopeParameter, 30),
  );
  aggregate.legalEntityScope = legalEntityScope(
    'exactlyOne',
    V4_SCOPE_IDS.aggregateScopeParameter,
  );

  const row = requireQuery(definition, V4_SCOPE_IDS.rowQuery);
  row.parameters = [parameterDefinition(V4_SCOPE_IDS.rowScopeParameter, 10)];
  row.legalEntityScope = legalEntityScope(
    'nonEmptySet',
    V4_SCOPE_IDS.rowScopeParameter,
  );
  return definition;
}

/** The same package with no operand anywhere — the version-only control. */
export function v4UnscopedModule(): MutableModule {
  return replaceVersion(
    v3AggregateModule(),
    LANGUAGE_VERSIONS.v3,
    LANGUAGE_VERSIONS.v4,
  ) as MutableModule;
}

export function legalEntityScope(
  cardinality: 'exactlyOne' | 'nonEmptySet',
  parameterId: string,
  schemaVersion: string = LANGUAGE_VERSIONS.v4,
): Record<string, unknown> {
  return {
    cardinality,
    kind: 'queryLegalEntityScope',
    operand: {
      kind: 'queryParameterReference',
      parameterId,
      schemaVersion,
    },
    schemaVersion,
  };
}

export function parameterDefinition(
  parameterId: string,
  orderKey: number,
  schemaVersion: string = LANGUAGE_VERSIONS.v4,
): Record<string, unknown> {
  return {
    kind: 'queryParameterDefinition',
    orderKey,
    parameterId,
    schemaVersion,
  };
}

export function requireQuery(
  definition: MutableModule,
  queryId: string,
): Record<string, unknown> {
  const query = definition.queries.find(
    (candidate) => candidate.queryId === queryId,
  );
  if (!query) throw new Error(`v4 fixture is missing query ${queryId}`);
  return query;
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

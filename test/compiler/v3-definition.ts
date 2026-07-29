import {
  LANGUAGE_VERSION,
  LANGUAGE_VERSIONS,
  NORMALIZATION_PROFILE_VERSIONS,
} from '../../packages/canonical-model/src/index.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV2,
} from '../fixtures/g2/module-conformance/definitions.js';

export const V3_AGGREGATE_IDS = Object.freeze({
  aggregateQuery: `${FIXTURE_IDS.namespace}:query.master_amount_sum`,
  aggregateSelection: `${FIXTURE_IDS.namespace}:selection.master_amount_sum`,
  atTimeParameter: `${FIXTURE_IDS.namespace}:parameter.at_time`,
  stockParameter: `${FIXTURE_IDS.namespace}:parameter.stock_identity`,
});

export function v3AggregateModule(): Record<string, unknown> {
  const definition = replaceVersion(
    ordinaryModuleV2(),
    LANGUAGE_VERSION,
    LANGUAGE_VERSIONS.v3,
  ) as {
    fields: Array<Record<string, unknown>>;
    impactAnalyses?: Array<Record<string, unknown>>;
    normalizationProfileVersion: string;
    queries: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  definition.normalizationProfileVersion = NORMALIZATION_PROFILE_VERSIONS.v3;
  const amount = definition.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentAmount,
  );
  if (!amount) throw new Error('v3 fixture amount field is missing');
  amount.presence = 'required';
  definition.impactAnalyses = [];
  definition.queries.push({
    aggregate: {
      field: reference('fieldReference', FIXTURE_IDS.fieldIds.parentAmount),
      kind: 'queryAggregateSelection',
      operator: 'sum',
      schemaVersion: LANGUAGE_VERSIONS.v3,
      selectionId: V3_AGGREGATE_IDS.aggregateSelection,
    },
    filter: {
      kind: 'allPredicate',
      schemaVersion: LANGUAGE_VERSIONS.v3,
      terms: [
        {
          field: reference('fieldReference', FIXTURE_IDS.fieldIds.parentNumber),
          kind: 'fieldComparisonPredicate',
          operator: 'equals',
          schemaVersion: LANGUAGE_VERSIONS.v3,
          value: {
            kind: 'queryParameterReference',
            parameterId: V3_AGGREGATE_IDS.stockParameter,
            schemaVersion: LANGUAGE_VERSIONS.v3,
          },
        },
        {
          field: reference(
            'fieldReference',
            FIXTURE_IDS.fieldIds.parentUtcInstant,
          ),
          kind: 'fieldComparisonPredicate',
          operator: 'lessThanOrEqual',
          schemaVersion: LANGUAGE_VERSIONS.v3,
          value: {
            kind: 'queryParameterReference',
            parameterId: V3_AGGREGATE_IDS.atTimeParameter,
            schemaVersion: LANGUAGE_VERSIONS.v3,
          },
        },
      ],
    },
    kind: 'queryDefinition',
    maximumResultCount: 1,
    module: reference('moduleReference', FIXTURE_IDS.moduleId),
    parameters: [
      {
        kind: 'queryParameterDefinition',
        orderKey: 10,
        parameterId: V3_AGGREGATE_IDS.stockParameter,
        schemaVersion: LANGUAGE_VERSIONS.v3,
      },
      {
        kind: 'queryParameterDefinition',
        orderKey: 20,
        parameterId: V3_AGGREGATE_IDS.atTimeParameter,
        schemaVersion: LANGUAGE_VERSIONS.v3,
      },
    ],
    permission: reference(
      'permissionReference',
      `${FIXTURE_IDS.namespace}:permission.master_read`,
    ),
    queryId: V3_AGGREGATE_IDS.aggregateQuery,
    queryType: 'aggregate',
    schemaVersion: LANGUAGE_VERSIONS.v3,
    sourceEntity: reference('entityReference', FIXTURE_IDS.entityIds.parent),
    tier: 'q1',
  });
  return definition;
}

function reference(kind: string, targetId: string): Record<string, unknown> {
  return { kind, schemaVersion: LANGUAGE_VERSIONS.v3, targetId };
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

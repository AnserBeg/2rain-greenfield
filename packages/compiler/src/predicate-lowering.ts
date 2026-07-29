import {
  PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_POSITION_PROFILE_VERSION,
  PredicateExpressionSchema,
  QUERY_AGGREGATE_LOWERING_PLAN_VERSION,
  VersionedPredicateExpressionSchema,
  canonicalizeAndHash,
  type NormalizedApplicationPackage,
  type ParameterizedPredicateLoweringNode,
  type ParameterizedPredicateLoweringPlan,
  type ParameterizedPredicateLoweringRowId,
  type PredicateCostClass,
  type PredicateExpression,
  type PredicateExpressionV3,
  type PredicateLoweringNode,
  type PredicateLoweringPlan,
  type PredicateLoweringRowId,
  type QueryAggregateLoweringPlan,
  type VersionedNormalizedApplicationPackage,
  type VersionedPredicateExpression,
} from '@north-star/canonical-model';

import type { StorageTargetPayloadV1 } from './storage.js';

export interface PredicateLoweringTableRow {
  readonly costClass: PredicateCostClass;
  readonly loweringRowId:
    | PredicateLoweringRowId
    | ParameterizedPredicateLoweringRowId
    | QueryAggregateLoweringPlan['loweringRowId'];
  readonly match:
    | 'foldedEqualityWithDeclaredIndex'
    | 'remainingComparison'
    | 'parameterizedComparison'
    | 'requiredSum';
  readonly providerProbeId: string;
}

/**
 * Closed, versioned admission table. Order is semantic: indexed
 * specializations precede their deny-by-default bounded-scan fallbacks.
 */
export const PREDICATE_LOWERING_TABLE: readonly PredicateLoweringTableRow[] =
  Object.freeze([
    Object.freeze({
      costClass: 'indexedFoldedEquality',
      loweringRowId: 'northstar.predicate-lowering/folded-equality-v1' as const,
      match: 'foldedEqualityWithDeclaredIndex' as const,
      providerProbeId: 'Q1-P1/indexed-folded-equality',
    }),
    Object.freeze({
      costClass: 'tenantBoundedScan',
      loweringRowId:
        'northstar.predicate-lowering/tenant-scan-comparison-v1' as const,
      match: 'remainingComparison' as const,
      providerProbeId: 'Q1-P1/tenant-bounded-scan',
    }),
    Object.freeze({
      costClass: 'tenantBoundedScan',
      loweringRowId:
        'northstar.predicate-lowering/parameterized-comparison-v1' as const,
      match: 'parameterizedComparison' as const,
      providerProbeId: 'Q1-P3b/parameterized-comparison-tenant-bounded-scan',
    }),
    Object.freeze({
      costClass: 'tenantBoundedScan',
      loweringRowId:
        'northstar.query-aggregate-lowering/required-sum-v1' as const,
      match: 'requiredSum' as const,
      providerProbeId: 'Q1-P3b/required-sum-tenant-bounded-scan',
    }),
  ]);

/**
 * v3 admits additional canonical spellings before their SQL lowering lands.
 * Keep the Q1-P1 lowering surface closed to the already-probed operators and
 * scalar operands while allowing those same shapes to retain v3 node stamps.
 */
export function isPredicateLoweringAdmitted(
  predicate: Readonly<VersionedPredicateExpression>,
): predicate is Readonly<PredicateExpression> {
  return PredicateExpressionSchema.safeParse(predicate).success;
}

export function lowerQueryPredicate(
  predicate: Readonly<PredicateExpression>,
  sourceEntityId: string,
  packageRevision: NormalizedApplicationPackage,
  storage: StorageTargetPayloadV1,
): PredicateLoweringPlan {
  const fields = new Map(
    packageRevision.fields.map((field) => [field.fieldId, field] as const),
  );
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === sourceEntityId,
  );
  if (!entity) {
    throw new Error('query predicate source entity has no storage target');
  }
  const root = lowerVersionedNode(
    predicate,
    fields,
    entity,
    false,
  ) as PredicateLoweringNode;
  return Object.freeze({
    costClass: costClassFor(root),
    kind: 'predicateLoweringPlan',
    positionProfileVersion: PREDICATE_POSITION_PROFILE_VERSION,
    predicateDigest: canonicalizeAndHash(predicate).contentHash,
    root,
    schemaVersion: PREDICATE_LOWERING_PLAN_VERSION,
  });
}

type AggregateQuery = Extract<
  VersionedNormalizedApplicationPackage['queries'][number],
  { queryType: 'aggregate' }
>;

export function lowerQueryAggregate(
  query: Readonly<AggregateQuery>,
  packageRevision: VersionedNormalizedApplicationPackage,
  storage: StorageTargetPayloadV1,
): Readonly<{
  aggregatePlan: QueryAggregateLoweringPlan;
  filterPlan: ParameterizedPredicateLoweringPlan;
}> {
  const fields = new Map(
    packageRevision.fields.map((field) => [field.fieldId, field] as const),
  );
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === query.sourceEntity.targetId,
  );
  if (!entity) {
    throw new Error('aggregate query source entity has no storage target');
  }
  if (!VersionedPredicateExpressionSchema.safeParse(query.filter).success) {
    throw new Error('aggregate query filter is outside the lowering table');
  }
  const root = lowerVersionedNode(
    query.filter,
    fields,
    entity,
    true,
  ) as ParameterizedPredicateLoweringNode;
  const row = PREDICATE_LOWERING_TABLE.find(
    (candidate) => candidate.match === 'requiredSum',
  );
  if (!row) throw new Error('aggregate lowering table row is missing');
  const aggregateField = fields.get(query.aggregate.field.targetId);
  if (!aggregateField) {
    throw new Error('aggregate source field has no canonical definition');
  }
  return Object.freeze({
    aggregatePlan: Object.freeze({
      costClass: 'tenantBoundedScan',
      kind: 'queryAggregateLoweringPlan',
      loweringRowId:
        row.loweringRowId as QueryAggregateLoweringPlan['loweringRowId'],
      providerProbeId:
        row.providerProbeId as QueryAggregateLoweringPlan['providerProbeId'],
      schemaVersion: QUERY_AGGREGATE_LOWERING_PLAN_VERSION,
      sourceFieldType: Object.freeze(structuredClone(aggregateField.fieldType)),
    }),
    filterPlan: Object.freeze({
      costClass: costClassFor(root),
      kind: 'predicateLoweringPlan',
      positionProfileVersion: PREDICATE_POSITION_PROFILE_VERSION,
      predicateDigest: canonicalizeAndHash(query.filter).contentHash,
      root,
      schemaVersion: PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION,
    }),
  });
}

type FieldDefinition = NormalizedApplicationPackage['fields'][number];
type StorageEntity = StorageTargetPayloadV1['entities'][number];

function lowerVersionedNode(
  predicate: Readonly<PredicateExpression | PredicateExpressionV3>,
  fields: ReadonlyMap<string, FieldDefinition>,
  entity: StorageEntity,
  parameterized: boolean,
): ParameterizedPredicateLoweringNode | PredicateLoweringNode {
  switch (predicate.kind) {
    case 'booleanPredicate':
      return Object.freeze({ kind: predicate.kind, value: predicate.value });
    case 'fieldComparisonPredicate': {
      const field = fields.get(predicate.field.targetId);
      const column = entity.columns.find(
        (candidate) => candidate.canonicalFieldId === predicate.field.targetId,
      );
      if (!field || !column) {
        throw new Error('query predicate field has no storage column');
      }
      const comparisonMode =
        field.fieldType.kind === 'textFieldType' &&
        field.collation === 'unicodeCaseInsensitive'
          ? ('unicodeCaseFold' as const)
          : ('binary' as const);
      const indexedFoldedEquality =
        predicate.operator === 'equals' &&
        comparisonMode === 'unicodeCaseFold' &&
        hasFoldedEqualityIndex(entity, column.physicalName, field.fieldId);
      const parameterizedComparison =
        parameterized &&
        (predicate.value.kind === 'queryParameterReference' ||
          predicate.operator === 'greaterThanOrEqual' ||
          predicate.operator === 'lessThanOrEqual');
      const row =
        PREDICATE_LOWERING_TABLE[
          indexedFoldedEquality ? 0 : parameterizedComparison ? 2 : 1
        ]!;
      return Object.freeze({
        comparisonMode,
        costClass: row.costClass,
        fieldId: field.fieldId,
        kind: predicate.kind,
        loweringRowId: row.loweringRowId as ParameterizedPredicateLoweringRowId,
        operator: predicate.operator,
        ...(parameterized
          ? {
              sourceFieldType: Object.freeze(structuredClone(field.fieldType)),
            }
          : {}),
        value: Object.freeze(structuredClone(predicate.value)),
      }) as ParameterizedPredicateLoweringNode | PredicateLoweringNode;
    }
    case 'notPredicate':
      return Object.freeze({
        kind: predicate.kind,
        term: lowerVersionedNode(predicate.term, fields, entity, parameterized),
      }) as ParameterizedPredicateLoweringNode | PredicateLoweringNode;
    case 'allPredicate':
    case 'anyPredicate':
      return Object.freeze({
        kind: predicate.kind,
        terms: Object.freeze(
          predicate.terms.map((term) =>
            lowerVersionedNode(term, fields, entity, parameterized),
          ),
        ),
      }) as ParameterizedPredicateLoweringNode | PredicateLoweringNode;
  }
}

function hasFoldedEqualityIndex(
  entity: StorageEntity,
  sourceColumn: string,
  fieldId: string,
): boolean {
  const folded = entity.foldedColumns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  if (!folded || folded.sourceColumn !== sourceColumn) return false;
  return entity.indexes.some(
    (index) =>
      (index.indexKind === 'foldedAccess' &&
        index.columnNames.includes(folded.physicalName)) ||
      (index.indexKind === 'caseInsensitiveUnique' &&
        index.columnNames.includes(sourceColumn)),
  );
}

function costClassFor(
  root: PredicateLoweringNode | ParameterizedPredicateLoweringNode,
): PredicateCostClass {
  return root.kind === 'fieldComparisonPredicate' &&
    root.costClass === 'indexedFoldedEquality'
    ? 'indexedFoldedEquality'
    : 'tenantBoundedScan';
}

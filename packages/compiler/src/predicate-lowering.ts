import {
  PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_POSITION_PROFILE_VERSION,
  canonicalizeAndHash,
  type NormalizedApplicationPackage,
  type PredicateCostClass,
  type PredicateExpression,
  type PredicateLoweringNode,
  type PredicateLoweringPlan,
  type PredicateLoweringRowId,
  type VersionedPredicateExpression,
} from '@north-star/canonical-model';

import type { StorageTargetPayloadV1 } from './storage.js';

export interface PredicateLoweringTableRow {
  readonly costClass: PredicateCostClass;
  readonly loweringRowId: PredicateLoweringRowId;
  readonly match: 'foldedEqualityWithDeclaredIndex' | 'remainingComparison';
  readonly providerProbeId: string;
}

/**
 * Closed v1 admission table. Order is semantic: the indexed specialization is
 * selected before the deny-by-default fallback for the remaining current
 * comparison vocabulary.
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
  ]);

/**
 * v3 admits additional canonical spellings before their SQL lowering lands.
 * Keep the Q1-P1 lowering surface closed to the already-probed operators and
 * scalar operands while allowing those same shapes to retain v3 node stamps.
 */
export function isPredicateLoweringAdmitted(
  predicate: Readonly<VersionedPredicateExpression>,
): predicate is Readonly<PredicateExpression> {
  switch (predicate.kind) {
    case 'booleanPredicate':
      return true;
    case 'fieldComparisonPredicate':
      return (
        predicate.value.kind !== 'queryParameterReference' &&
        (predicate.operator === 'equals' ||
          predicate.operator === 'notEquals' ||
          predicate.operator === 'lessThan' ||
          predicate.operator === 'greaterThan')
      );
    case 'notPredicate':
      return isPredicateLoweringAdmitted(predicate.term);
    case 'allPredicate':
    case 'anyPredicate':
      return predicate.terms.every(isPredicateLoweringAdmitted);
  }
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
  const root = lowerNode(predicate, fields, entity);
  return Object.freeze({
    costClass: costClassFor(root),
    kind: 'predicateLoweringPlan',
    positionProfileVersion: PREDICATE_POSITION_PROFILE_VERSION,
    predicateDigest: canonicalizeAndHash(predicate).contentHash,
    root,
    schemaVersion: PREDICATE_LOWERING_PLAN_VERSION,
  });
}

type FieldDefinition = NormalizedApplicationPackage['fields'][number];
type StorageEntity = StorageTargetPayloadV1['entities'][number];

function lowerNode(
  predicate: Readonly<PredicateExpression>,
  fields: ReadonlyMap<string, FieldDefinition>,
  entity: StorageEntity,
): PredicateLoweringNode {
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
      const row = PREDICATE_LOWERING_TABLE[indexedFoldedEquality ? 0 : 1]!;
      return Object.freeze({
        comparisonMode,
        costClass: row.costClass,
        fieldId: field.fieldId,
        kind: predicate.kind,
        loweringRowId: row.loweringRowId,
        operator: predicate.operator,
        value: Object.freeze(structuredClone(predicate.value)),
      });
    }
    case 'notPredicate':
      return Object.freeze({
        kind: predicate.kind,
        term: lowerNode(predicate.term, fields, entity),
      });
    case 'allPredicate':
    case 'anyPredicate':
      return Object.freeze({
        kind: predicate.kind,
        terms: Object.freeze(
          predicate.terms.map((term) => lowerNode(term, fields, entity)),
        ),
      });
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

function costClassFor(root: PredicateLoweringNode): PredicateCostClass {
  return root.kind === 'fieldComparisonPredicate' &&
    root.costClass === 'indexedFoldedEquality'
    ? 'indexedFoldedEquality'
    : 'tenantBoundedScan';
}

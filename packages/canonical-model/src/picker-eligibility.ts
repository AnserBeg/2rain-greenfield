import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import { inspectPredicateForExecution } from './predicate-kernel.js';

interface PickerEligibility {
  readonly queryId: string;
  readonly relationId: string;
  readonly filters: readonly {
    readonly fieldId: string;
    readonly value: string;
  }[];
}

/**
 * Why a picker's eligibility cannot be honoured, or `null` when it can. It
 * reads another entity's whole unscoped, unfiltered List: its owned relation
 * must point from that entity to the picker's (so one record's eligibility is
 * an exact parent-scoped read), and every filter must be a selected field of
 * it with an admissible value. Shared by draft editor pickers and Task inputs.
 */
export function pickerEligibilityProblem(
  model: VersionedNormalizedApplicationPackage,
  eligibility: PickerEligibility,
  pickerEntityId: string,
): string | null {
  const query = model.queries.find(
    (value) => value.queryId === eligibility.queryId,
  );
  const relation = model.relations.find(
    (value) => value.relationId === eligibility.relationId,
  );
  if (
    query?.queryType !== 'list' ||
    ('legalEntityScope' in query && query.legalEntityScope) ||
    ('filter' in query &&
      query.filter &&
      inspectPredicateForExecution(query.filter).outcome !== 'accepted') ||
    relation?.sourceEntity.targetId !== query.sourceEntity.targetId ||
    relation.targetEntity.targetId !== pickerEntityId ||
    relation.ownership !== 'parentScopedChild' ||
    new Set(eligibility.filters.map((filter) => filter.fieldId)).size !==
      eligibility.filters.length
  )
    return 'picker eligibility requires an unscoped List of an entity related to the picker entity';
  for (const filter of eligibility.filters) {
    const type = model.fields.find(
      (value) => value.fieldId === filter.fieldId,
    )?.fieldType;
    if (
      !query.selections.some(
        (value) => value.field.targetId === filter.fieldId,
      ) ||
      (type?.kind === 'enumFieldType'
        ? !type.options.some((option) => option.optionId === filter.value)
        : type?.kind !== 'textFieldType' ||
          filter.value.length > type.maximumLength)
    )
      return 'picker eligibility filters require selected fields and admissible values';
  }
  return null;
}

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

/** A child entity whose text field also answers a List's or a picker's search. */
export interface SearchChild {
  readonly queryId: string;
  readonly relationId: string;
  readonly fieldId: string;
}

/**
 * Why a search through children cannot be honoured, or `null` when it can
 * (CATALOG-EXTRAS). The statement reads the child entity whole -- every
 * active child, in no company -- so its list must be an active unscoped q0
 * list without a read model or a filter the kernel would not admit; the
 * child's own relation must be parentScopedChild and point at the searched
 * entity; the field must be one of the child's text fields that list
 * selects. Shared by declared Lists and draft editor pickers.
 */
export function searchChildProblem(
  model: VersionedNormalizedApplicationPackage,
  child: SearchChild,
  searchedEntityId: string,
): string | null {
  const query = model.queries.find((value) => value.queryId === child.queryId);
  const relation = model.relations.find(
    (value) => value.relationId === child.relationId,
  );
  const field = model.fields.find((value) => value.fieldId === child.fieldId);
  if (
    query?.queryType !== 'list' ||
    query.lifecycle !== 'active' ||
    query.tier !== 'q0' ||
    ('legalEntityScope' in query && query.legalEntityScope) ||
    ('readModel' in query && query.readModel) ||
    ('filter' in query &&
      query.filter &&
      inspectPredicateForExecution(query.filter).outcome !== 'accepted')
  )
    return 'a search through children reads an active unscoped q0 list query of the child entity';
  if (
    relation?.lifecycle !== 'active' ||
    relation.ownership !== 'parentScopedChild' ||
    relation.sourceEntity.targetId !== query.sourceEntity.targetId ||
    relation.targetEntity.targetId !== searchedEntityId
  )
    return 'a search through children follows their parentScopedChild relation to the searched entity';
  if (
    field?.entity.targetId !== query.sourceEntity.targetId ||
    field.fieldType.kind !== 'textFieldType' ||
    !query.selections.some((value) => value.field.targetId === child.fieldId)
  )
    return 'a search through children matches a text field their list query selects';
  return null;
}

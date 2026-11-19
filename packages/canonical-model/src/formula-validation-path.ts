import type { ValidationOperand } from './formula-validation.js';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

type Revision = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>;

export function resolveValidationPath(
  operand: Extract<ValidationOperand, { kind: 'path' }>,
  sourceEntityId: string,
  revision: Pick<Revision, 'relations' | 'fields' | 'entities' | 'queries'>,
) {
  const [relationId] = operand.relationIds;
  if (!relationId || operand.relationIds.length !== 1) return null;
  const relation = revision.relations.find(
    (entry) =>
      entry.relationId === relationId &&
      entry.lifecycle === 'active' &&
      entry.cardinality === 'manyToOne' &&
      entry.sourceEntity.targetId === sourceEntityId,
  );
  if (!relation) return null;
  const targetEntityId = relation.targetEntity.targetId;
  if (
    !revision.entities.some(
      (entity) =>
        entity.entityId === targetEntityId && entity.lifecycle === 'active',
    )
  )
    return null;
  const field = revision.fields.find(
    (entry) =>
      entry.fieldId === operand.fieldId &&
      entry.lifecycle === 'active' &&
      entry.entity.targetId === targetEntityId &&
      (entry.classification === 'public' ||
        entry.classification === 'internal'),
  );
  if (!field) return null;
  const reader = revision.queries.find(
    (query) =>
      query.lifecycle === 'active' &&
      query.tier === 'q0' &&
      query.queryType === 'get' &&
      query.filter?.kind === 'booleanPredicate' &&
      query.filter.value &&
      query.legalEntityScope === undefined &&
      query.sourceEntity.targetId === targetEntityId &&
      query.selections.some(
        ({ field: selection }) => selection.targetId === operand.fieldId,
      ),
  );
  return reader ? { field, reader, relation } : null;
}

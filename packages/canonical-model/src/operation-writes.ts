import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

/** A narrowed write contract cannot name another entity, a number, or an unsupported effect. */
export function validateOperationWrites(
  model: VersionedNormalizedApplicationPackage,
): void {
  const fields = new Map(
    model.fields.map((field) => [String(field.fieldId), field]),
  );
  const relations = new Map(
    model.relations.map((relation) => [String(relation.relationId), relation]),
  );
  for (const operation of model.operations) {
    const writes =
      'fieldWrites' in operation ? operation.fieldWrites : undefined;
    const relationWrites =
      'relationWrites' in operation ? operation.relationWrites : undefined;
    if (!writes && !relationWrites) continue;
    const fail = (message: string): never => {
      throw new CanonicalModelError([
        diagnostic(
          'CANON_SCHEMA_INVALID',
          '$.operations.fieldWrites',
          message,
          'declare unique writable fields of this create or update operation',
          String(operation.operationId),
        ),
      ]);
    };
    if (
      operation.effect.kind !== 'createRecordEffect' &&
      operation.effect.kind !== 'updateRecordEffect'
    )
      fail('fieldWrites belongs to a create or update record operation');
    const entityId =
      'entity' in operation.effect ? operation.effect.entity.targetId : '';
    const seen = new Set<string>();
    for (const write of writes ?? []) {
      const id = String(write.field.targetId);
      const field =
        fields.get(id) ??
        fail('fieldWrites names an active field of the operation entity');
      if (seen.has(id)) fail('fieldWrites repeats a field');
      seen.add(id);
      if (
        write.field.kind !== 'fieldReference' ||
        field.lifecycle !== 'active' ||
        field.entity.targetId !== entityId
      )
        fail('fieldWrites names an active field of the operation entity');
      if ('numbering' in field && field.numbering)
        fail('a server-assigned number cannot be an operation input');
      if (
        write.nonBlank &&
        (field.fieldType.kind !== 'textFieldType' || !write.required)
      )
        fail('nonBlank belongs to a required text input');
    }
    if (writes && operation.effect.kind === 'createRecordEffect') {
      for (const field of model.fields) {
        if (
          field.entity.targetId === entityId &&
          field.lifecycle === 'active' &&
          field.presence === 'required' &&
          field.defaultSemantics !== 'declaredDefault' &&
          !('numbering' in field && field.numbering) &&
          !seen.has(String(field.fieldId))
        )
          fail(
            'a create write contract must include required fields without defaults',
          );
      }
    }
    if (relationWrites) {
      if (operation.effect.kind !== 'updateRecordEffect')
        fail('relationWrites belongs to an update record operation');
      const seenRelations = new Set<string>();
      for (const write of relationWrites) {
        const id = String(write.relation);
        const relation =
          relations.get(id) ??
          fail(
            'relationWrites names an active relation of the operation entity',
          );
        if (seenRelations.has(id)) fail('relationWrites repeats a relation');
        seenRelations.add(id);
        if (
          relation.lifecycle !== 'active' ||
          relation.sourceEntity.targetId !== entityId ||
          relation.ownership !== 'reference' ||
          !['manyToOne', 'oneToOne'].includes(relation.cardinality) ||
          ('fieldBinding' in relation && relation.fieldBinding)
        )
          fail(
            'relationWrites names a to-one reference relation with its own column',
          );
        if (write.acyclic && relation.targetEntity.targetId !== entityId)
          fail('an acyclic update belongs to a self relation');
      }
    }
  }
}

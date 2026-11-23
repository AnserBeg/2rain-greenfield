import {
  deriveLogicalFieldBindings,
  type LogicalFieldBinding,
  type VersionedNormalizedApplicationPackage,
} from '@north-star/canonical-model';

/**
 * CUSTOMIZE-6 slice 1. Admits each `logicalFields` declaration against its one
 * field (the same derivation a serving loader repeats from the pinned
 * revision) and refuses the record types v1 does not admit by name: a
 * first-party record type and a line table.
 */
export interface LogicalFieldRefusal {
  readonly subjectId: string;
  readonly path: string;
  readonly message: string;
}

function isTenantRecordType(entityId: string): boolean {
  return (entityId.split(':')[1] ?? '').startsWith('entity.custom_');
}

export function compileLogicalFields(
  def: VersionedNormalizedApplicationPackage,
): { payload: LogicalFieldBinding[] } | LogicalFieldRefusal | null {
  if (def.languageVersion !== 'v6' || !def.logicalFields) return null;
  const refuse = (subjectId: string, message: string) => ({
    subjectId,
    path: '$.logicalFields',
    message,
  });
  for (const declaration of def.logicalFields) {
    if (!isTenantRecordType(declaration.entityId))
      return refuse(
        declaration.fieldId,
        `logical field ${declaration.fieldId}: only a tenant record type can hold a ${declaration.logicalType} field in v1 (first-party records are a named gap).`,
      );
    if (
      def.relations.some(
        (r) =>
          r.ownership === 'parentScopedChild' &&
          r.sourceEntity.targetId === declaration.entityId,
      )
    )
      return refuse(
        declaration.fieldId,
        `logical field ${declaration.fieldId}: a line table cannot hold a ${declaration.logicalType} field in v1.`,
      );
  }
  const outcome = deriveLogicalFieldBindings(
    def as unknown as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
  if (outcome.status === 'refused')
    return refuse(outcome.fieldId, outcome.message);
  return { payload: outcome.bindings };
}

import {
  DateTimeBindingSchema,
  dateTimeConsumerRefusal,
  type DateTimeBinding,
  type VersionedNormalizedApplicationPackage,
} from '@north-star/canonical-model';

/**
 * ADR-0087 slice 1. Admits each `dateTimeFields` declaration against its one
 * logical field and refuses every consumer v1 does not admit, by logical type,
 * before any backing scalar is inspected. A refusal names the logical type,
 * the field and the consumer or operand position.
 */
export interface DateTimeRefusal {
  readonly subjectId: string;
  readonly path: string;
  readonly message: string;
}

function isTenantRecordType(entityId: string): boolean {
  return (entityId.split(':')[1] ?? '').startsWith('entity.custom_');
}

export function compileDateTimeFields(
  def: VersionedNormalizedApplicationPackage,
): { payload: DateTimeBinding[] } | DateTimeRefusal | null {
  if (def.languageVersion !== 'v6') return null;
  const declarations = def.dateTimeFields ?? [];
  if (declarations.length === 0) return null;
  const declared = new Set<string>();
  const active: DateTimeBinding[] = [];
  for (const declaration of declarations) {
    const refuse = (detail: string): DateTimeRefusal => ({
      subjectId: declaration.fieldId,
      path: '$.dateTimeFields',
      message: `dateTime field ${declaration.fieldId}: ${detail}`,
    });
    if (declared.has(declaration.fieldId))
      return refuse('the field is declared twice.');
    declared.add(declaration.fieldId);
    const field = def.fields.find((f) => f.fieldId === declaration.fieldId);
    const entity = def.entities.find(
      (e) => e.entityId === declaration.entityId,
    );
    if (!field || !entity || field.entity.targetId !== declaration.entityId)
      return refuse('the declaration must name one field on its record type.');
    if (!isTenantRecordType(declaration.entityId))
      return refuse(
        'only a tenant record type can hold a dateTime field in v1 (first-party records, document headers and lines are named gaps).',
      );
    if (
      def.relations.some(
        (r) =>
          r.ownership === 'parentScopedChild' &&
          r.sourceEntity.targetId === declaration.entityId,
      )
    )
      return refuse('a line table cannot hold a dateTime field in v1.');
    const type = field.fieldType;
    if (
      type.kind !== 'dateTimeFieldType' ||
      type.timezoneSemantics !== 'utcInstant' ||
      type.precision !== 'millisecond'
    )
      return refuse(
        'the logical field must store a millisecond UTC instant as its scalar.',
      );
    if (field.searchable)
      return refuse('search is a capability gap for the dateTime type.');
    if (field.classification !== 'internal')
      return refuse('the field must be internal; its components inherit it.');
    if (field.lifecycle === 'active')
      active.push(DateTimeBindingSchema.parse(declaration));
  }
  const activeIds = new Set(active.map((binding) => binding.fieldId));
  const refusal = dateTimeConsumerRefusal(
    def as unknown as Record<string, unknown>,
    activeIds,
  );
  if (refusal) return refusal;
  return {
    payload: active.sort((left, right) =>
      left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0,
    ),
  };
}

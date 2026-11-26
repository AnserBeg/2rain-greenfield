import {
  DATE_TIME_FIELD_READER,
  DateTimeBindingSchema,
  type DateTimeBinding,
  canonicalize,
} from '@north-star/canonical-model';

/** Inspect only the dateTime declaration and its field in the pinned revision. */
export function declaredDateTimeFields(bytes: Uint8Array) {
  const definition = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    dateTimeFields?: DateTimeBinding[];
    fields: {
      fieldId: string;
      entity: { targetId: string };
      lifecycle: string;
    }[];
  };
  const active: DateTimeBinding[] = [];
  const retired = new Set<string>();
  for (const declaration of definition.dateTimeFields ?? []) {
    const binding = DateTimeBindingSchema.parse(declaration);
    const field = definition.fields.find(
      (f) =>
        f.fieldId === binding.fieldId && f.entity.targetId === binding.entityId,
    );
    if (field?.lifecycle === 'retired') retired.add(binding.fieldId);
    else if (field?.lifecycle === 'active') active.push(binding);
    else
      throw new Error(
        `dateTime declaration has no matching active or retired field: ${binding.fieldId}`,
      );
  }
  return {
    definition,
    active: active.sort((a, b) =>
      a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
    ),
    retired,
  };
}

/**
 * ADR-0087 serving admission: the operation, query and surface catalogs carry
 * identical dateTime bindings, and a binding raises the surface reader floor
 * to its rung. Missing bindings and an understated floor refuse before serving.
 */
export function dateTimeBindingsProblem(
  consumerPayloads: readonly unknown[],
  surfaceFloor: number,
  active: readonly DateTimeBinding[],
): string | null {
  const bound = consumerPayloads.filter(
    (payload) =>
      payload !== null &&
      typeof payload === 'object' &&
      Object.hasOwn(payload, 'dateTimeBindings'),
  ) as { readonly dateTimeBindings: unknown }[];
  if (canonicalize(bound[0]?.dateTimeBindings ?? []) !== canonicalize(active))
    return 'dateTime catalog bindings disagree with active field declarations.';
  if (bound.length === 0)
    return surfaceFloor === DATE_TIME_FIELD_READER
      ? 'dateTime floor without dateTime bindings.'
      : null;
  const bindings = bound[0]!.dateTimeBindings;
  if (
    bound.length !== consumerPayloads.length ||
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    !bindings.every((b) => DateTimeBindingSchema.safeParse(b).success) ||
    !bound.every(
      (payload) =>
        canonicalize(payload.dateTimeBindings) === canonicalize(bindings),
    )
  )
    return 'dateTime bindings disagree across the catalogs.';
  if (surfaceFloor < DATE_TIME_FIELD_READER)
    return 'dateTime bindings need the dateTime surface reader floor.';
  return null;
}

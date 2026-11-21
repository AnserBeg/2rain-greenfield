import {
  DATE_TIME_FIELD_READER,
  DateTimeBindingSchema,
  canonicalize,
} from '@north-star/canonical-model';

/**
 * ADR-0087 serving admission: the operation, query and surface catalogs carry
 * identical dateTime bindings, and a binding raises the surface reader floor
 * to its rung. Missing bindings and an understated floor refuse before serving.
 */
export function dateTimeBindingsProblem(
  consumerPayloads: readonly unknown[],
  surfaceFloor: number,
): string | null {
  const bound = consumerPayloads.filter(
    (payload) =>
      payload !== null &&
      typeof payload === 'object' &&
      Object.hasOwn(payload, 'dateTimeBindings'),
  ) as { readonly dateTimeBindings: unknown }[];
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

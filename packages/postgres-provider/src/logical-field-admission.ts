import {
  LOGICAL_FIELD_READER,
  canonicalize,
  deriveLogicalFieldBindings,
} from '@north-star/canonical-model';

/**
 * CUSTOMIZE-6 serving admission. The surface manifest's logical field
 * bindings are recomputed from the pinned revision -- the same derivation the
 * compiler ran -- and must agree exactly; a declaration raises the surface
 * reader floor to its rung, and a binding or that floor without a
 * declaration refuses. Nothing is served from a disagreement.
 */
export function logicalFieldBindingsProblem(
  surfacePayload: unknown,
  surfaceFloor: number,
  revision: Uint8Array,
): string | null {
  const definition = JSON.parse(Buffer.from(revision).toString('utf8')) as {
    logicalFields?: unknown;
  };
  const carried =
    surfacePayload !== null &&
    typeof surfacePayload === 'object' &&
    Object.hasOwn(surfacePayload, 'logicalFieldBindings');
  if (!Object.hasOwn(definition, 'logicalFields')) {
    if (carried) return 'logical field bindings without declarations.';
    return surfaceFloor === LOGICAL_FIELD_READER
      ? 'logical field floor without logical field declarations.'
      : null;
  }
  const outcome = deriveLogicalFieldBindings(
    definition as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
  if (outcome.status === 'refused')
    return `invalid logical field declaration: ${outcome.message}`;
  if (
    !carried ||
    canonicalize(
      (surfacePayload as { logicalFieldBindings: unknown })
        .logicalFieldBindings,
    ) !== canonicalize(outcome.bindings)
  )
    return 'logical field bindings disagree with the field declarations.';
  if (surfaceFloor < LOGICAL_FIELD_READER)
    return 'logical field bindings need the logical field surface reader floor.';
  return null;
}

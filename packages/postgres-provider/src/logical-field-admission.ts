import {
  LINE_LOGICAL_FIELD_READER,
  LOGICAL_FIELD_READER,
  canonicalize,
  deriveLogicalFieldBindings,
  logicalFieldReaderFloor,
} from '@north-star/canonical-model';

/**
 * CUSTOMIZE-6 serving admission. The surface manifest's logical field
 * bindings are recomputed from the pinned revision -- the same derivation the
 * compiler ran -- and must agree exactly; a declaration raises the surface
 * reader floor to its rung (the line rung for line tables and header-read
 * currencies), and a binding or that floor without a declaration refuses.
 * Nothing is served from a disagreement.
 */
export function logicalFieldBindingsProblem(
  surfacePayload: unknown,
  surfaceFloor: number,
  revision: Uint8Array,
): string | null {
  const definition: Record<string, unknown> & { logicalFields?: unknown[] } =
    JSON.parse(Buffer.from(revision).toString('utf8')) as {
      logicalFields?: unknown[];
    };
  const carried =
    surfacePayload !== null &&
    typeof surfacePayload === 'object' &&
    Object.hasOwn(surfacePayload, 'logicalFieldBindings');
  if (!Object.hasOwn(definition, 'logicalFields')) {
    if (carried) return 'logical field bindings without declarations.';
    return surfaceFloor === LOGICAL_FIELD_READER ||
      surfaceFloor === LINE_LOGICAL_FIELD_READER
      ? 'logical field floor without logical field declarations.'
      : null;
  }
  const outcome = deriveLogicalFieldBindings(
    definition as unknown as Parameters<typeof deriveLogicalFieldBindings>[0],
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
  const floor =
    logicalFieldReaderFloor(
      definition as unknown as Parameters<typeof logicalFieldReaderFloor>[0],
    ) ?? LOGICAL_FIELD_READER;
  if (surfaceFloor < floor)
    return floor === LINE_LOGICAL_FIELD_READER
      ? 'line logical fields need the line logical field surface reader floor.'
      : 'logical field bindings need the logical field surface reader floor.';
  if (
    floor === LOGICAL_FIELD_READER &&
    surfaceFloor === LINE_LOGICAL_FIELD_READER
  )
    return 'line logical field floor without line logical fields.';
  return null;
}

/**
 * CUSTOMIZE-6 (slice 1 follow-up, rule 14): every write contract's
 * `allowedTexts` is exactly its field's declared allowed values, and a field
 * that declares them carries them on every contract. A forged or stale
 * contract would accept a value the declaration refuses, or refuse one it
 * allows.
 */
export function allowedTextsContractProblem(
  operationCatalogPayload: unknown,
  revision: Uint8Array,
): string | null {
  const definition: Record<string, unknown> & { logicalFields?: unknown[] } =
    JSON.parse(Buffer.from(revision).toString('utf8')) as {
      logicalFields?: unknown[];
    };
  let declared = new Map<string, readonly string[]>();
  if (Object.hasOwn(definition, 'logicalFields')) {
    const outcome = deriveLogicalFieldBindings(
      definition as unknown as Parameters<typeof deriveLogicalFieldBindings>[0],
    );
    if (outcome.status === 'refused')
      return `invalid logical field declaration: ${outcome.message}`;
    declared = new Map(
      outcome.bindings.flatMap((binding) =>
        binding.allowedValues
          ? [[String(binding.fieldId), binding.allowedValues] as const]
          : [],
      ),
    );
  }
  const operations = (
    operationCatalogPayload as {
      operations?: {
        operationId?: unknown;
        inputContract?: { fields?: Record<string, unknown>[] };
      }[];
    } | null
  )?.operations;
  for (const operation of operations ?? [])
    for (const field of operation.inputContract?.fields ?? []) {
      const expected = declared.get(String(field.fieldId));
      const carried = Object.hasOwn(field, 'allowedTexts')
        ? field.allowedTexts
        : undefined;
      if (
        canonicalize(carried ?? null) !==
        canonicalize(expected ? [...expected] : null)
      )
        return `the write contract of ${String(operation.operationId)} disagrees with the allowed values declared for ${String(field.fieldId)}.`;
    }
  return null;
}

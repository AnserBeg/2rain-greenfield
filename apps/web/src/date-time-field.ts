import {
  DateTimeBindingSchema,
  SavedDateTimeSchema,
  formatRecordZone,
  type DateTimeBinding,
} from '@north-star/canonical-model';

/**
 * ADR-0087 on the web: a logical dateTime field is entered as a civil date and
 * time in one-minute steps, with a zone for a per-record field, and shown in
 * record zone. The server resolves every entry; a refused entry comes back
 * with the typed values preserved and, in a repeated hour, both offsets to
 * choose from.
 */
type Payload = { readonly dateTimeBindings?: unknown };

export function dateTimeBindings(
  surfacePayload: unknown,
): ReadonlyMap<string, DateTimeBinding> {
  const bindings = (surfacePayload as Payload | null)?.dateTimeBindings;
  return new Map(
    (Array.isArray(bindings) ? bindings : []).flatMap((binding) => {
      const parsed = DateTimeBindingSchema.safeParse(binding);
      return parsed.success
        ? [[parsed.data.fieldId, parsed.data] as const]
        : [];
    }),
  );
}

/** Record-zone text for a captured value, or null when the value is not one. */
export function recordZoneText(value: unknown): string | null {
  const saved = SavedDateTimeSchema.safeParse(value);
  return saved.success ? formatRecordZone(saved.data) : null;
}

/**
 * The whole logical value a form submits, or `nothing` when the recorded
 * capture was re-sent unchanged (an untouched field keeps its capture).
 */
export function dateTimeFromForm(
  name: string,
  submission: Readonly<Record<string, string | undefined>>,
):
  | { readonly kind: 'nothing' }
  | { readonly kind: 'set'; readonly value: Record<string, string | number> } {
  const civil = submission[name] ?? '';
  const zone = submission[`${name}:zone`]?.trim() || undefined;
  const offset = submission[`${name}:offset`]?.trim();
  const recorded = submission[`${name}:recorded`]?.split('|');
  if (
    recorded &&
    recorded[0]?.slice(0, 16) === civil &&
    (zone === undefined || zone === recorded[1]) &&
    !offset
  )
    return { kind: 'nothing' };
  return {
    kind: 'set',
    value: {
      schemaVersion: 'northstar.date-time-value/v1',
      civil,
      ...(zone ? { zone } : {}),
      ...(offset ? { offsetSeconds: Number(offset) } : {}),
    },
  };
}

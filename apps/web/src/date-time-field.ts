import {
  DateTimeBindingSchema,
  SavedDateTimeSchema,
  canonicalZone,
  formatRecordZone,
  offsetLabel,
  type DateTimeBinding,
} from '@north-star/canonical-model';
import { escapeHtml } from './html.js';

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
      return parsed.success ? [[parsed.data.fieldId, parsed.data] as const] : [];
    }),
  );
}

/** Record-zone text for a captured value, or null when the value is not one. */
export function recordZoneText(value: unknown): string | null {
  const saved = SavedDateTimeSchema.safeParse(value);
  return saved.success ? formatRecordZone(saved.data) : null;
}

let zones: readonly string[] | null = null;
function zoneOptions(): readonly string[] {
  zones ??= [
    ...new Set(
      Intl.supportedValuesOf('timeZone').flatMap((name) => {
        const canonical = canonicalZone(name);
        return canonical ? [canonical] : [];
      }),
    ),
  ].sort();
  return zones;
}

interface ProposedEntry {
  readonly civil?: string;
  readonly zone?: string;
  readonly offsetSeconds?: number;
  readonly offsets?: readonly number[];
}

export function renderDateTimeEntry(
  binding: DateTimeBinding,
  name: string,
  value: unknown,
  attributes: string,
): string {
  const saved = SavedDateTimeSchema.safeParse(value).data;
  const proposed = (saved ? null : (value as ProposedEntry | null)) ?? null;
  const civil = (saved?.civil ?? proposed?.civil ?? '').slice(0, 16);
  const zone = saved?.zone ?? proposed?.zone ?? '';
  const parts = [
    `<input type="datetime-local" step="60"${attributes} data-date-time-field="${escapeHtml(binding.zoneSource.kind)}" name="${name}" value="${escapeHtml(civil)}" autocomplete="off">`,
  ];
  if (saved) {
    // The recorded capture: re-sending it unchanged leaves it untouched.
    parts.push(
      `<input type="hidden" name="${name}:recorded" value="${escapeHtml(`${saved.civil}|${saved.zone}|${String(saved.offsetSeconds)}`)}">`,
      `<small class="form-hint">Recorded ${escapeHtml(formatRecordZone(saved))}</small>`,
    );
  }
  if (binding.zoneSource.kind === 'perRecordIana') {
    const options = zoneOptions()
      .map(
        (option) =>
          `<option value="${escapeHtml(option)}"${option === zone ? ' selected' : ''}>${escapeHtml(option)}</option>`,
      )
      .join('');
    parts.push(
      `<select name="${name}:zone" aria-label="Time zone"><option value="">Company calendar zone</option>${options}</select>`,
    );
  }
  if (proposed?.offsets?.length) {
    parts.push(
      `<select name="${name}:offset" required aria-label="Which ${escapeHtml(civil.slice(11))}"><option value="">Choose the offset</option>${proposed.offsets
        .map(
          (offset) =>
            `<option value="${String(offset)}">${escapeHtml(offsetLabel(offset))}</option>`,
        )
        .join('')}</select>`,
    );
  }
  return `<span class="date-time-entry">${parts.join('')}</span>`;
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

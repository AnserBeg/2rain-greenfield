import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * ADR-0087 slice 1: the tenant `dateTime` point field.
 *
 * The logical field is one ordinary v6 field whose declared type is an
 * existing scalar, `dateTimeFieldType` + `utcInstant` + `millisecond`: the
 * stored instant. The optional v6 `dateTimeFields` declaration projects that
 * instant and the private capture components below as ONE logical value. The
 * canonical field-kind union and `timezoneSemantics` are unchanged, and the
 * `dateOnly` editor's midnight-UTC encoding is never used.
 */
export const DATE_TIME_FIELD_READER = 35;
export const DATE_TIME_PATCH_VERSION = 'northstar.date-time-field/v1';
export const DATE_TIME_VALUE_VERSION = 'northstar.date-time-value/v1';
export const DATE_TIME_ZONE_SOURCES = [
  'companyBusinessCalendar',
  'perRecordIana',
] as const;
export type DateTimeZoneSourceKind = (typeof DATE_TIME_ZONE_SOURCES)[number];

const id = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
export const DateTimeZoneSourceSchema = z.strictObject({
  kind: z.enum(DATE_TIME_ZONE_SOURCES),
  version: z.literal('v1'),
});
export const DateTimeFieldDeclarationSchema = z.strictObject({
  schemaVersion: z.literal('v6'),
  fieldId: id,
  entityId: id,
  logicalType: z.literal('dateTime'),
  zoneSource: DateTimeZoneSourceSchema,
});
export type DateTimeFieldDeclaration = z.infer<
  typeof DateTimeFieldDeclarationSchema
>;
/** What every consumer projection carries: the stable field ID and its contract. */
export const DateTimeBindingSchema = DateTimeFieldDeclarationSchema;
export type DateTimeBinding = DateTimeFieldDeclaration;

// The instant is the logical field's own column. The capture components are
// private storage, identified from the stable field ID alone.
export const DATE_TIME_COMPONENTS = [
  'civil',
  'offsetSeconds',
  'zone',
  'tzdbVersion',
  'zoneSource',
  'companyId',
  'calendarId',
  'dayBoundary',
] as const;
export type DateTimeComponent = (typeof DATE_TIME_COMPONENTS)[number];
export const DATE_TIME_COMPONENT_NAMESPACE = 'northstar.datetime';
export function dateTimeComponentId(
  fieldId: string,
  component: DateTimeComponent,
): string {
  return (
    `${DATE_TIME_COMPONENT_NAMESPACE}:field.scalar_` +
    createHash('sha256').update(fieldId).digest('hex') +
    '.' +
    component.toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// Values

const civilPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/u;
/** What a form, the API or the assistant writes. */
export const DateTimeWriteSchema = z.strictObject({
  schemaVersion: z.literal(DATE_TIME_VALUE_VERSION),
  civil: z.string().max(40),
  zone: z.string().min(1).max(64).optional(),
  offsetSeconds: z.int().min(-64800).max(64800).optional(),
});
export type DateTimeWrite = z.infer<typeof DateTimeWriteSchema>;
export const SavedDateTimeSchema = z.strictObject({
  schemaVersion: z.literal(DATE_TIME_VALUE_VERSION),
  instant: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  civil: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/u),
  offsetSeconds: z.int().min(-64800).max(64800),
  zone: z.string().min(1).max(64),
  tzdbVersion: z.string().min(1).max(16),
  zoneSource: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('perRecordIana') }),
    z.strictObject({
      kind: z.literal('companyBusinessCalendar'),
      companyId: z.string().min(1).max(36),
      calendarId: z.string().min(1).max(64),
      dayBoundary: z.string().regex(/^\d{2}:\d{2}:\d{2}\.\d{3}$/u),
    }),
  ]),
});
export type SavedDateTime = z.infer<typeof SavedDateTimeSchema>;

export interface CivilDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export type DateTimeEntryRefusal =
  | { readonly code: 'DATE_TIME_MALFORMED'; readonly message: string }
  | { readonly code: 'DATE_TIME_PRECISION_EXCEEDED'; readonly message: string }
  | { readonly code: 'DATE_TIME_ZONE_INVALID'; readonly message: string }
  | {
      readonly code: 'DATE_TIME_NONEXISTENT';
      readonly message: string;
      readonly civil: string;
      readonly zone: string;
    }
  | {
      readonly code: 'DATE_TIME_AMBIGUOUS';
      readonly message: string;
      readonly civil: string;
      readonly zone: string;
      readonly offsets: readonly number[];
    }
  | {
      readonly code: 'DATE_TIME_OFFSET_INVALID';
      readonly message: string;
      readonly civil: string;
      readonly zone: string;
      readonly offsets: readonly number[];
    };

export function parseCivil(text: string): CivilDateTime | DateTimeEntryRefusal {
  const match = civilPattern.exec(text);
  if (!match)
    return {
      code: 'DATE_TIME_MALFORMED',
      message: 'Enter a date and time as YYYY-MM-DDTHH:MM.',
    };
  const fraction = match[7] ?? '';
  // Refused before any rounding: the server keeps up to milliseconds.
  if (fraction.length > 3)
    return {
      code: 'DATE_TIME_PRECISION_EXCEEDED',
      message: 'A time is kept to the millisecond; enter fewer digits.',
    };
  const civil = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
    millisecond: Number(fraction.padEnd(3, '0') || '0'),
  };
  const probe = new Date(
    Date.UTC(
      civil.year,
      civil.month - 1,
      civil.day,
      civil.hour,
      civil.minute,
      civil.second,
    ),
  );
  if (
    civil.year < 1 ||
    probe.getUTCFullYear() !== civil.year ||
    probe.getUTCMonth() !== civil.month - 1 ||
    probe.getUTCDate() !== civil.day ||
    probe.getUTCHours() !== civil.hour ||
    probe.getUTCMinutes() !== civil.minute ||
    probe.getUTCSeconds() !== civil.second
  )
    return {
      code: 'DATE_TIME_MALFORMED',
      message: 'That date or time does not exist on the calendar.',
    };
  return civil;
}

export function civilText(civil: CivilDateTime): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(civil.year, 4)}-${pad(civil.month)}-${pad(civil.day)}T${pad(civil.hour)}:${pad(civil.minute)}:${pad(civil.second)}.${pad(civil.millisecond, 3)}`;
}

// ICU reports CLDR's canonical spelling, which keeps several names IANA has
// renamed. Those renames are mapped back to the IANA canonical ID; a link that
// ICU already resolves (Canada/Eastern -> America/Toronto) needs no entry.
const CLDR_TO_IANA: Readonly<Record<string, string>> = Object.freeze({
  UTC: 'Etc/UTC',
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
});

/** The canonical IANA ID, or null for an unknown name or a fixed-offset ID. */
export function canonicalZone(name: string): string | null {
  if (/^Etc\/GMT[+-]\d{1,2}$/u.test(name)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  const canonical = CLDR_TO_IANA[resolved] ?? resolved;
  if (canonical.startsWith('Etc/') && canonical !== 'Etc/UTC') return null;
  if (!canonical.includes('/')) return null;
  return canonical;
}

/** The tz database version of this process, recorded with each capture. */
export function processTzdbVersion(): string {
  const versions = (
    globalThis as { process?: { versions?: Record<string, string> } }
  ).process?.versions;
  const version = versions?.tz;
  if (!version) throw new Error('The time-zone database version is unknown.');
  return version;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
/** The zone's UTC offset, in seconds, at an instant. */
export function zoneOffsetSeconds(zone: string, instantMs: number): number {
  let format = offsetFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    });
    offsetFormats.set(zone, format);
  }
  const name =
    format
      .formatToParts(new Date(instantMs))
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  if (name === 'GMT') return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(name);
  if (!match) throw new Error(`Unrecognized offset ${name} for ${zone}`);
  const seconds =
    Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? '0');
  return match[1] === '-' ? -seconds : seconds;
}

/** Every instant whose civil time in the zone is exactly `civil`. */
export function civilCandidates(
  civil: CivilDateTime,
  zone: string,
): { instantMs: number; offsetSeconds: number }[] {
  const local = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
    civil.millisecond,
  );
  const day = 86_400_000;
  const offsets = new Set(
    [local - day, local, local + day].map((probe) =>
      zoneOffsetSeconds(zone, probe),
    ),
  );
  return [...offsets]
    .map((offsetSeconds) => ({
      instantMs: local - offsetSeconds * 1000,
      offsetSeconds,
    }))
    .filter(
      (candidate) =>
        zoneOffsetSeconds(zone, candidate.instantMs) ===
        candidate.offsetSeconds,
    )
    .sort((left, right) => left.instantMs - right.instantMs);
}

/**
 * Typed entry. A civil time in a DST gap is refused with the input preserved;
 * a repeated civil time needs one of its offsets; a supplied offset must be
 * valid for the civil time in that zone.
 */
export function resolveTypedEntry(
  civilInput: string,
  zone: string,
  offsetSeconds?: number,
):
  | {
      readonly status: 'resolved';
      readonly civil: string;
      readonly instant: string;
      readonly offsetSeconds: number;
    }
  | ({ readonly status: 'refused' } & DateTimeEntryRefusal) {
  const civil = parseCivil(civilInput);
  if ('code' in civil) return { status: 'refused', ...civil };
  const candidates = civilCandidates(civil, zone);
  const offsets = candidates.map((candidate) => candidate.offsetSeconds);
  if (candidates.length === 0)
    return {
      status: 'refused',
      code: 'DATE_TIME_NONEXISTENT',
      message: `${civilInput} does not occur in ${zone}; the clocks skip that time.`,
      civil: civilInput,
      zone,
    };
  const chosen =
    offsetSeconds === undefined
      ? candidates.length === 1
        ? candidates[0]
        : undefined
      : candidates.find(
          (candidate) => candidate.offsetSeconds === offsetSeconds,
        );
  if (!chosen && offsetSeconds === undefined)
    return {
      status: 'refused',
      code: 'DATE_TIME_AMBIGUOUS',
      message: `${civilInput} happens twice in ${zone}; choose ${offsets.map(offsetLabel).join(' or ')}.`,
      civil: civilInput,
      zone,
      offsets,
    };
  if (!chosen)
    return {
      status: 'refused',
      code: 'DATE_TIME_OFFSET_INVALID',
      message: `${offsetLabel(offsetSeconds!)} is not an offset of ${zone} at ${civilInput}.`,
      civil: civilInput,
      zone,
      offsets,
    };
  return {
    status: 'resolved',
    civil: civilText(civil),
    instant: new Date(chosen.instantMs).toISOString(),
    offsetSeconds: chosen.offsetSeconds,
  };
}

/** `UTC−05:00`, with the minus sign U+2212. */
export function offsetLabel(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '−' : '+';
  const magnitude = Math.abs(offsetSeconds);
  const hours = String(Math.floor(magnitude / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((magnitude % 3600) / 60)).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * Record-zone display: the captured civil value with its offset and IANA name.
 * Pure string work over the capture, so no process, session or template zone
 * can move it. Every reader without an explicit viewer switch uses it.
 */
export function formatRecordZone(value: SavedDateTime): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u.exec(
      value.civil,
    );
  if (!match) throw new Error('A saved civil value is malformed.');
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const time =
    millisecond !== '000'
      ? `${hour}:${minute}:${second}.${millisecond}`
      : second !== '00'
        ? `${hour}:${minute}:${second}`
        : `${hour}:${minute}`;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}, ${time} ${offsetLabel(value.offsetSeconds)} ${value.zone}`;
}

/** A date-only (calendar date) value printed as its civil date, unconverted. */
export function formatCivilDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) throw new Error('A civil date is malformed.');
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

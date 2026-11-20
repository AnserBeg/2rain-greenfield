import {
  DATE_TIME_COMPONENTS,
  DateTimeWriteSchema,
  SavedDateTimeSchema,
  canonicalZone,
  dateTimeComponentId,
  processTzdbVersion,
  resolveTypedEntry,
  type DateTimeComponent,
  type SavedDateTime,
} from '@north-star/canonical-model';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';

/**
 * ADR-0087 slice 1 in the provider: the logical `dateTime` value is resolved
 * on the server for every channel (form, API, assistant), written whole into
 * its private columns, and read back as one value. The entity's capture check
 * is the authority for which fields are logical and where they live.
 */
type Entity = StorageTargetPayloadV1['entities'][number];
type CaptureCheck = NonNullable<Entity['dateTimeCaptureChecks']>[number];
type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export class DateTimeEntryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fieldId: string,
    readonly details: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'DateTimeEntryError';
  }
}

export function dateTimeChecks(entity: Entity): readonly CaptureCheck[] {
  return entity.dateTimeCaptureChecks ?? [];
}

export function dateTimeCheck(
  entity: Entity,
  fieldId: string,
): CaptureCheck | undefined {
  return dateTimeChecks(entity).find(
    (check) => check.canonicalFieldId === fieldId,
  );
}

const componentIds = new WeakMap<Entity, ReadonlySet<string>>();
export function isDateTimeComponent(entity: Entity, fieldId: string): boolean {
  let ids = componentIds.get(entity);
  if (!ids) {
    ids = new Set(
      dateTimeChecks(entity).flatMap((check) =>
        DATE_TIME_COMPONENTS.map((component) =>
          dateTimeComponentId(check.canonicalFieldId, component),
        ),
      ),
    );
    componentIds.set(entity, ids);
  }
  return ids.has(fieldId);
}

/**
 * The SELECT expression for a capture column, or null for every other
 * column. Temporal values leave PostgreSQL as fixed-format text, so neither
 * the driver nor the process time zone ever builds a Date from them.
 */
export function dateTimeColumnExpression(
  entity: Entity,
  physicalName: string,
  qualifiedName: string,
): string | null {
  for (const check of dateTimeChecks(entity)) {
    if (physicalName === check.columns.instant)
      return `to_char(${qualifiedName} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    if (physicalName === check.columns.civil)
      return `to_char(${qualifiedName}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
    if (physicalName === check.columns.dayBoundary)
      return `to_char(${qualifiedName}, 'HH24:MI:SS.MS')`;
  }
  return null;
}

export function readDateTime(
  check: CaptureCheck,
  row: Readonly<Record<string, unknown>>,
): SavedDateTime | null {
  const get = (key: 'instant' | DateTimeComponent) => row[check.columns[key]];
  if (get('instant') === null || get('instant') === undefined) return null;
  const source = String(get('zoneSource'));
  return SavedDateTimeSchema.parse({
    schemaVersion: 'northstar.date-time-value/v1',
    instant: get('instant'),
    civil: get('civil'),
    offsetSeconds: Number(get('offsetSeconds')),
    zone: get('zone'),
    tzdbVersion: get('tzdbVersion'),
    zoneSource:
      source === 'companyBusinessCalendar'
        ? {
            kind: source,
            companyId: get('companyId'),
            calendarId: get('calendarId'),
            dayBoundary: get('dayBoundary'),
          }
        : { kind: source },
  });
}

/** The private column values for one whole logical value, or all null. */
export function dateTimeScalars(
  fieldId: string,
  value: SavedDateTime | null,
): Record<string, string | number | null> {
  const company =
    value?.zoneSource.kind === 'companyBusinessCalendar'
      ? value.zoneSource
      : null;
  const parts: Record<'instant' | DateTimeComponent, string | number | null> =
    {
      instant: value?.instant ?? null,
      civil: value?.civil ?? null,
      offsetSeconds: value?.offsetSeconds ?? null,
      zone: value?.zone ?? null,
      tzdbVersion: value?.tzdbVersion ?? null,
      zoneSource: value?.zoneSource.kind ?? null,
      companyId: company?.companyId ?? null,
      calendarId: company?.calendarId ?? null,
      dayBoundary: company?.dayBoundary ?? null,
    };
  return {
    [fieldId]: parts.instant,
    ...Object.fromEntries(
      DATE_TIME_COMPONENTS.map((component) => [
        dateTimeComponentId(fieldId, component),
        parts[component],
      ]),
    ),
  };
}

export interface BusinessCalendarContext {
  readonly calendarId: string;
  readonly zone: string;
  readonly dayBoundary: string;
}

/**
 * Typed entry for every touched logical field. An untouched field is absent
 * from the patch and keeps its capture. Re-sending the recorded civil value
 * (and, if given, its zone and offset) is also untouched; any other civil
 * entry resolves afresh -- the current company calendar for a company-sourced
 * field, the selected zone for a per-record field -- and records a new capture.
 */
export function resolveDateTimePatch(
  entity: Entity,
  patch: Readonly<Record<string, Json>>,
  context: {
    readonly calendar: BusinessCalendarContext | null;
    readonly companyId: string | null;
    readonly prior: Readonly<Record<string, Json>> | null;
  },
): Record<string, Json> {
  const resolved: Record<string, Json> = { ...patch };
  for (const [fieldId, value] of Object.entries(patch)) {
    const check = dateTimeCheck(entity, fieldId);
    if (!check || value === null) continue;
    const refuse = (
      code: string,
      message: string,
      details: Record<string, string> = {},
    ) => new DateTimeEntryError(code, message, fieldId, details);
    const write = DateTimeWriteSchema.safeParse(value);
    if (!write.success)
      throw refuse(
        'DATE_TIME_MALFORMED',
        'A date-time value is written whole: a civil date and time, with an optional zone and offset.',
      );
    const prior = SavedDateTimeSchema.safeParse(context.prior?.[fieldId]).data;
    if (prior && untouched(write.data, prior)) {
      resolved[fieldId] = prior as unknown as Json;
      continue;
    }
    const company = check.zoneSource === 'companyBusinessCalendar';
    let zone: string | null;
    if (company) {
      if (!context.calendar)
        throw refuse(
          'DATE_TIME_CALENDAR_REQUIRED',
          'This field uses the company business calendar, and none is set up.',
        );
      if (!context.companyId)
        throw refuse(
          'DATE_TIME_COMPANY_REQUIRED',
          'Choose the company whose business calendar this field uses.',
        );
      zone = context.calendar.zone;
      if (
        write.data.zone !== undefined &&
        canonicalZone(write.data.zone) !== zone
      )
        throw refuse(
          'DATE_TIME_ZONE_INVALID',
          `This field takes its company's business calendar zone, ${zone}.`,
          { zone: write.data.zone },
        );
    } else {
      const requested = write.data.zone ?? context.calendar?.zone;
      if (requested === undefined)
        throw refuse(
          'DATE_TIME_ZONE_INVALID',
          'Choose a time zone for this date and time.',
        );
      zone = canonicalZone(requested);
      if (!zone)
        throw refuse(
          'DATE_TIME_ZONE_INVALID',
          `${requested} is not a supported IANA time zone; fixed-offset zones are refused.`,
          { zone: requested },
        );
    }
    const entry = resolveTypedEntry(
      write.data.civil,
      zone,
      write.data.offsetSeconds,
    );
    if (entry.status === 'refused') {
      const details: Record<string, string> = {
        reason: entry.code,
        civil: write.data.civil,
        zone,
      };
      if ('offsets' in entry) details.offsets = entry.offsets.join(',');
      throw refuse(entry.code, entry.message, details);
    }
    const saved: SavedDateTime = {
      schemaVersion: 'northstar.date-time-value/v1',
      instant: entry.instant,
      civil: entry.civil,
      offsetSeconds: entry.offsetSeconds,
      zone,
      tzdbVersion: processTzdbVersion(),
      zoneSource: company
        ? {
            kind: 'companyBusinessCalendar',
            companyId: context.companyId!,
            calendarId: context.calendar!.calendarId,
            dayBoundary: context.calendar!.dayBoundary,
          }
        : { kind: 'perRecordIana' },
    };
    resolved[fieldId] = SavedDateTimeSchema.parse(saved) as unknown as Json;
  }
  return resolved;
}

function untouched(
  write: ReturnType<typeof DateTimeWriteSchema.parse>,
  prior: SavedDateTime,
): boolean {
  const civil = /^(.*T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(
    write.civil,
  );
  if (!civil) return false;
  const normalized = `${civil[1]}:${civil[2] ?? '00'}.${(civil[3] ?? '').padEnd(3, '0')}`;
  return (
    normalized === prior.civil &&
    (write.zone === undefined || canonicalZone(write.zone) === prior.zone) &&
    (write.offsetSeconds === undefined ||
      write.offsetSeconds === prior.offsetSeconds)
  );
}

/** Replaces each resolved logical value with its column values. */
export function expandDateTimePatch(
  entity: Entity,
  patch: Readonly<Record<string, Json>>,
): Record<string, Json> {
  const expanded: Record<string, Json> = { ...patch };
  for (const [fieldId, value] of Object.entries(patch)) {
    if (!dateTimeCheck(entity, fieldId)) continue;
    Object.assign(
      expanded,
      dateTimeScalars(
        fieldId,
        value === null ? null : SavedDateTimeSchema.parse(value),
      ),
    );
  }
  return expanded;
}

/**
 * The compiled bindings and the storage target name the same logical fields
 * with the same zone sources, in both directions, or the write refuses.
 */
export function dateTimeStorageDisagreement(
  bindingsPayload: unknown,
  storage: StorageTargetPayloadV1,
): string | null {
  const bindings =
    bindingsPayload && typeof bindingsPayload === 'object'
      ? (bindingsPayload as { dateTimeBindings?: unknown }).dateTimeBindings
      : undefined;
  const bound = new Map(
    (Array.isArray(bindings) ? bindings : []).map((binding) => {
      const b = binding as {
        fieldId: string;
        entityId: string;
        zoneSource: { kind: string };
      };
      return [b.fieldId, `${b.entityId}|${b.zoneSource.kind}`] as const;
    }),
  );
  for (const entity of storage.entities)
    for (const check of dateTimeChecks(entity)) {
      const expected = bound.get(check.canonicalFieldId);
      // A retired field keeps its storage and leaves the bindings.
      if (expected === undefined) continue;
      if (expected !== `${entity.entityId}|${check.zoneSource}`)
        return check.canonicalFieldId;
      bound.delete(check.canonicalFieldId);
    }
  return bound.size > 0 ? [...bound.keys()][0]! : null;
}

/**
 * What the agent is told so it never has to guess: the company's business day
 * and the currency its documents default to.
 *
 * The business date is the tenant's (ADR-0018): the declared IANA time zone and
 * business-day boundary, never the server's or the model's clock. The default
 * currency is read from the pinned release's declared editor default for the
 * documents' currency field (the same default the order form offers), because
 * the domain holds no company-level currency setting; a customer's or
 * supplier's own default currency, when set, takes precedence and is read from
 * its record.
 */
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';

/** The tenant's declaration, as provisioned (`InventoryScopeProvisioning`). */
export interface BusinessCalendar {
  /** IANA zone, e.g. `America/Edmonton`. */
  readonly timeZone: string;
  /** Time of day a business day starts, `HH:MM:SS` local, e.g. `00:00:00`. */
  readonly businessDayBoundary: string;
}

export interface BusinessDay {
  /** The business date, `YYYY-MM-DD`. */
  readonly date: string;
  /** That date as a midnight-UTC instant, the way date fields are written. */
  readonly asDateTime: string;
}

const boundaryPattern = /^(\d{2}):(\d{2}):(\d{2})$/u;

/** The business date at an instant: the zone's wall clock less the boundary. */
export function businessDayAt(
  instant: Date,
  calendar: BusinessCalendar,
): BusinessDay {
  const boundary = boundaryPattern.exec(calendar.businessDayBoundary);
  if (!boundary) throw new TypeError('businessDayBoundary must be HH:MM:SS');
  const boundaryMs =
    (Number(boundary[1]) * 3600 +
      Number(boundary[2]) * 60 +
      Number(boundary[3])) *
    1000;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: calendar.timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const wallMs = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  const day = new Date(wallMs - boundaryMs);
  const midnight = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
  );
  const asDateTime = new Date(midnight).toISOString();
  return { date: asDateTime.slice(0, 10), asDateTime };
}

export interface CurrencyDefault {
  /** The declared default code, or null when the release declares none. */
  readonly code: string | null;
  readonly offered: readonly string[];
}

const currencies = new WeakMap<object, CurrencyDefault>();

/**
 * The currency the order forms start from, read from the compiled surface
 * projection: header fields named `*_currency` with a declared choice default.
 * One agreed default is reported; none or a disagreement reports null, because
 * the agent must then ask rather than pick.
 */
export function declaredCurrencyDefault(
  view: RequestRuntimeView,
): CurrencyDefault {
  const payload = view.projections.surface.payload as object;
  const cached = currencies.get(payload);
  if (cached) return cached;
  const defaults = new Set<string>();
  const offered = new Set<string>();
  const visit = (value: ImmutableJsonValue): void => {
    if (Array.isArray(value)) {
      for (const member of value) visit(member);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Readonly<Record<string, ImmutableJsonValue>>;
    const presentation = record.presentation as
      Readonly<Record<string, ImmutableJsonValue>> | undefined;
    if (
      typeof record.fieldId === 'string' &&
      record.fieldId.endsWith('_currency') &&
      typeof presentation === 'object' &&
      presentation !== null &&
      !Array.isArray(presentation) &&
      presentation.kind === 'choice'
    ) {
      if (typeof presentation.defaultValue === 'string')
        defaults.add(presentation.defaultValue);
      if (Array.isArray(presentation.options))
        for (const option of presentation.options)
          if (
            typeof option === 'object' &&
            option !== null &&
            !Array.isArray(option) &&
            typeof option.value === 'string'
          )
            offered.add(option.value);
    }
    for (const member of Object.values(record)) visit(member);
  };
  visit(payload as ImmutableJsonValue);
  const result: CurrencyDefault = {
    code: defaults.size === 1 ? [...defaults][0]! : null,
    offered: [...offered].sort(),
  };
  currencies.set(payload, result);
  return result;
}

const choiceDefaults = new WeakMap<object, Readonly<Record<string, string>>>();

/**
 * What the screens pre-select when nobody chooses, read from the compiled
 * surface projection: every declared choice default on a field or form input,
 * keyed by its local name (`invoice_method`, `sales_order_currency`). It is the
 * domain's own default, so an agent that was not told a value may use it.
 */
export function declaredChoiceDefaults(
  view: RequestRuntimeView,
): Readonly<Record<string, string>> {
  const payload = view.projections.surface.payload as object;
  const cached = choiceDefaults.get(payload);
  if (cached) return cached;
  const found: Record<string, string> = {};
  const visit = (value: ImmutableJsonValue): void => {
    if (Array.isArray(value)) {
      for (const member of value) visit(member);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Readonly<Record<string, ImmutableJsonValue>>;
    const presentation = record.presentation as
      Readonly<Record<string, ImmutableJsonValue>> | undefined;
    const id = record.fieldId ?? record.inputId;
    if (
      typeof id === 'string' &&
      typeof presentation === 'object' &&
      presentation !== null &&
      !Array.isArray(presentation) &&
      presentation.kind === 'choice' &&
      typeof presentation.defaultValue === 'string'
    )
      found[id.slice(id.lastIndexOf('.') + 1)] = presentation.defaultValue;
    for (const member of Object.values(record)) visit(member);
  };
  visit(payload as ImmutableJsonValue);
  const sorted = Object.freeze(
    Object.fromEntries(
      Object.entries(found).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  choiceDefaults.set(payload, sorted);
  return sorted;
}

import type { ImmutableJsonValue } from '../request-runtime-view.js';
import { assertExactKeys, isRecord, malformed } from './contract.js';

/**
 * LIST FIGURES. Per listed row, figures the list statement computes in its
 * FROM, before the count and the page window: sums over the rows of declared
 * list queries that hold the listed record's id in one of their text fields
 * (an item's stock balances, reservations and order lines hold the item as
 * plain text), signed totals of them, bands that name their ranges, and the
 * latest record id a parent of such rows holds. `keep` narrows the set to rows
 * whose band holds one of its values -- a tab counts, pages and exports that
 * set exactly. The figures come back in each record's values under their ids.
 *
 * Every id here is resolved by the gateway against the pinned query catalog
 * and by the executor against the pinned compiled storage; nothing a request
 * names becomes a table or a column any other way.
 */
export interface SharedListFigureRows {
  readonly matchFieldId: string;
  readonly queryId: string;
  readonly quantityFieldId?: string;
}

/** Only rows whose parent, through their relation to it, holds a value. */
export interface SharedListFigureWithin {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
  readonly values: readonly string[];
}

/** Rows pointing at each figure row through a relation, and their quantity. */
export interface SharedListFigureRelated {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
}

/**
 * `rows` adds the rows' quantity, `related` their related rows' quantity and
 * `remaining` each row's quantity less its related rows', never below zero.
 */
export interface SharedListFigureSum {
  readonly figureId: string;
  readonly related?: SharedListFigureRelated;
  readonly rows: SharedListFigureRows;
  readonly sum: 'related' | 'remaining' | 'rows';
  readonly within?: SharedListFigureWithin;
}

/** A figure declared before, or an exact decimal the listed query selects. */
export type SharedListFigureOperand =
  { readonly figureId: string } | { readonly fieldId: string };

export interface SharedListFigureTotal {
  readonly figureId: string;
  readonly floor?: 'zero';
  readonly minus: readonly SharedListFigureOperand[];
  readonly plus: readonly SharedListFigureOperand[];
}

/** A listed row's exact decimal, or a canonical decimal, compared with. */
export type SharedListFigureThreshold =
  { readonly fieldId: string } | { readonly value: string };

export interface SharedListFigureBandCase {
  readonly atMost?: SharedListFigureThreshold;
  readonly below?: SharedListFigureThreshold;
  readonly value: string;
}

export interface SharedListFigureBand {
  readonly cases: readonly SharedListFigureBandCase[];
  readonly figureId: string;
  readonly of: string;
  readonly otherwise: string;
}

export interface SharedListFigureLatest {
  readonly byFieldId: string;
  readonly figureId: string;
  readonly label: { readonly fieldId: string; readonly queryId: string };
  readonly rows: { readonly matchFieldId: string; readonly queryId: string };
  readonly valueFieldId: string;
  readonly within: SharedListFigureWithin;
}

export interface SharedListFigures {
  readonly bands?: readonly SharedListFigureBand[];
  readonly keep?: {
    readonly figureId: string;
    readonly values: readonly string[];
  };
  readonly latest?: readonly SharedListFigureLatest[];
  readonly sums: readonly SharedListFigureSum[];
  readonly totals?: readonly SharedListFigureTotal[];
}

/** Figures whose queries passed current policy, with each query's entity. */
export interface AuthorizedSharedListFigures {
  /** The source entity of every query the figures read, by query id. */
  readonly entityIds: Readonly<Record<string, string>>;
  readonly figures: SharedListFigures;
}

/** Every figure's kind by id, in the order the statement computes them. */
export function sharedListFigureKinds(
  figures: SharedListFigures,
): ReadonlyMap<string, 'band' | 'latest' | 'number'> {
  return new Map<string, 'band' | 'latest' | 'number'>([
    ...figures.sums.map((sum) => [sum.figureId, 'number'] as const),
    ...(figures.totals ?? []).map(
      (total) => [total.figureId, 'number'] as const,
    ),
    ...(figures.bands ?? []).map((band) => [band.figureId, 'band'] as const),
    ...(figures.latest ?? []).map(
      (latest) => [latest.figureId, 'latest'] as const,
    ),
  ]);
}

/**
 * The listed row's own fields the figures compare or add: every one must be a
 * field the listed query selects, which the caller checks.
 */
export function sharedListFigureRowFields(
  figures: SharedListFigures,
): readonly string[] {
  const field = (value: SharedListFigureOperand | SharedListFigureThreshold) =>
    'fieldId' in value ? [value.fieldId] : [];
  return [
    ...(figures.totals ?? []).flatMap((total) =>
      [...total.plus, ...total.minus].flatMap(field),
    ),
    ...(figures.bands ?? []).flatMap((band) =>
      band.cases.flatMap((entry) => field(entry.below ?? entry.atMost!)),
    ),
  ];
}

const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const signedDecimalPattern =
  /^(?:0|-?(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9]))$/u;

function canonicalId(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 5 ||
    value.length > 180 ||
    !canonicalIdPattern.test(value)
  )
    throw malformed(`list figures ${name} must be a canonical ID`);
  return value;
}

function record(
  value: ImmutableJsonValue | undefined,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, ImmutableJsonValue | undefined>> {
  if (!isRecord(value))
    throw malformed(`list figures ${name} must be an object`);
  assertExactKeys(value, [...required, ...optional], true);
  if (required.some((key) => !Object.hasOwn(value, key)))
    throw malformed(`list figures ${name} is missing a required member`);
  return value;
}

function list(
  value: ImmutableJsonValue | undefined,
  name: string,
  minimum: number,
  maximum: number,
): readonly ImmutableJsonValue[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw malformed(
      `list figures ${name} holds ${String(minimum)} to ${String(maximum)} entries`,
    );
  return value as readonly ImmutableJsonValue[];
}

function strings(
  value: ImmutableJsonValue | undefined,
  name: string,
  maximum: number,
  canonical: boolean,
): readonly string[] {
  const entries = list(value, name, 1, maximum).map((entry) => {
    if (canonical) return canonicalId(entry, name);
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 240)
      throw malformed(`list figures ${name} are 1 to 240 characters`);
    return entry;
  });
  if (new Set(entries).size !== entries.length)
    throw malformed(`list figures ${name} must be unique`);
  return Object.freeze(entries);
}

function parseWithin(value: ImmutableJsonValue | undefined) {
  const within = record(value, 'within', [
    'fieldId',
    'queryId',
    'relationId',
    'values',
  ]);
  return Object.freeze({
    fieldId: canonicalId(within.fieldId, 'within fieldId'),
    queryId: canonicalId(within.queryId, 'within queryId'),
    relationId: canonicalId(within.relationId, 'within relationId'),
    values: strings(within.values, 'within values', 8, false),
  });
}

function parseOperand(value: ImmutableJsonValue): SharedListFigureOperand {
  if (!isRecord(value)) throw malformed('list figures operand is an object');
  if (Object.hasOwn(value, 'figureId')) {
    assertExactKeys(value, ['figureId']);
    return Object.freeze({
      figureId: canonicalId(value.figureId, 'operand figureId'),
    });
  }
  assertExactKeys(value, ['fieldId']);
  return Object.freeze({
    fieldId: canonicalId(value.fieldId, 'operand fieldId'),
  });
}

function parseThreshold(
  value: ImmutableJsonValue | undefined,
): SharedListFigureThreshold {
  if (!isRecord(value)) throw malformed('list figures threshold is an object');
  if (Object.hasOwn(value, 'value')) {
    assertExactKeys(value, ['value']);
    if (
      typeof value.value !== 'string' ||
      !signedDecimalPattern.test(value.value)
    )
      throw malformed('list figures threshold value is a canonical decimal');
    return Object.freeze({ value: value.value });
  }
  assertExactKeys(value, ['fieldId']);
  return Object.freeze({
    fieldId: canonicalId(value.fieldId, 'threshold fieldId'),
  });
}

/**
 * The closed request contract. Beyond each member's shape it proves what the
 * statement relies on: unique figure ids, a sum naming exactly the parts it
 * adds, totals and bands over figures declared before them, and a `keep` of
 * values its band declares -- so the executor never meets a dangling id.
 */
export function parseSharedListFigures(
  value: ImmutableJsonValue,
): SharedListFigures {
  const figures = record(
    value,
    'argument',
    ['sums'],
    ['bands', 'keep', 'latest', 'totals'],
  );
  const ids = new Set<string>();
  const declare = (figureId: unknown) => {
    const id = canonicalId(figureId, 'figureId');
    if (ids.has(id)) throw malformed('list figures ids must be unique');
    ids.add(id);
    return id;
  };
  const numbers = new Set<string>();
  const sums = list(figures.sums, 'sums', 1, 8).map(
    (entry): SharedListFigureSum => {
      const sum = record(
        entry,
        'sum',
        ['figureId', 'rows', 'sum'],
        ['related', 'within'],
      );
      const figureId = declare(sum.figureId);
      const rows = record(
        sum.rows,
        'rows',
        ['matchFieldId', 'queryId'],
        ['quantityFieldId'],
      );
      if (
        sum.sum !== 'rows' &&
        sum.sum !== 'related' &&
        sum.sum !== 'remaining'
      )
        throw malformed('list figures sum is rows, related or remaining');
      // `rows` adds a quantity, `related` related rows, `remaining` both.
      if (
        (rows.quantityFieldId !== undefined) !== (sum.sum !== 'related') ||
        (sum.related !== undefined) !== (sum.sum !== 'rows')
      )
        throw malformed('list figures sum names exactly the parts it adds');
      const related =
        sum.related === undefined
          ? undefined
          : record(sum.related, 'related', [
              'fieldId',
              'queryId',
              'relationId',
            ]);
      numbers.add(figureId);
      return Object.freeze({
        figureId,
        ...(related
          ? {
              related: Object.freeze({
                fieldId: canonicalId(related.fieldId, 'related fieldId'),
                queryId: canonicalId(related.queryId, 'related queryId'),
                relationId: canonicalId(
                  related.relationId,
                  'related relationId',
                ),
              }),
            }
          : {}),
        rows: Object.freeze({
          matchFieldId: canonicalId(rows.matchFieldId, 'rows matchFieldId'),
          queryId: canonicalId(rows.queryId, 'rows queryId'),
          ...(rows.quantityFieldId === undefined
            ? {}
            : {
                quantityFieldId: canonicalId(
                  rows.quantityFieldId,
                  'rows quantityFieldId',
                ),
              }),
        }),
        sum: sum.sum,
        ...(sum.within === undefined
          ? {}
          : { within: parseWithin(sum.within) }),
      });
    },
  );
  const totals =
    figures.totals === undefined
      ? undefined
      : list(figures.totals, 'totals', 1, 6).map(
          (entry): SharedListFigureTotal => {
            const total = record(
              entry,
              'total',
              ['figureId', 'minus', 'plus'],
              ['floor'],
            );
            const figureId = declare(total.figureId);
            if (total.floor !== undefined && total.floor !== 'zero')
              throw malformed('list figures total floor is zero');
            const operands = (key: 'minus' | 'plus', minimum: number) =>
              Object.freeze(
                list(total[key], `total ${key}`, minimum, 6).map((operand) => {
                  const parsed = parseOperand(operand);
                  if ('figureId' in parsed && !numbers.has(parsed.figureId))
                    throw malformed(
                      'list figures total adds figures declared before it',
                    );
                  return parsed;
                }),
              );
            const plus = operands('plus', 1);
            const minus = operands('minus', 0);
            numbers.add(figureId);
            return Object.freeze({
              figureId,
              ...(total.floor === 'zero' ? { floor: 'zero' as const } : {}),
              minus,
              plus,
            });
          },
        );
  const bandValues = new Map<string, ReadonlySet<string>>();
  const bands =
    figures.bands === undefined
      ? undefined
      : list(figures.bands, 'bands', 1, 2).map(
          (entry): SharedListFigureBand => {
            const band = record(entry, 'band', [
              'cases',
              'figureId',
              'of',
              'otherwise',
            ]);
            const figureId = declare(band.figureId);
            const of = canonicalId(band.of, 'band of');
            if (!numbers.has(of))
              throw malformed('list figures band names a sum or a total');
            const cases = list(band.cases, 'band cases', 1, 4).map(
              (candidate): SharedListFigureBandCase => {
                const entry = record(
                  candidate,
                  'band case',
                  ['value'],
                  ['atMost', 'below'],
                );
                if (
                  (entry.below === undefined) ===
                  (entry.atMost === undefined)
                )
                  throw malformed(
                    'list figures band case compares with exactly one threshold',
                  );
                return Object.freeze({
                  value: canonicalId(entry.value, 'band case value'),
                  ...(entry.below === undefined
                    ? {}
                    : { below: parseThreshold(entry.below) }),
                  ...(entry.atMost === undefined
                    ? {}
                    : { atMost: parseThreshold(entry.atMost) }),
                });
              },
            );
            const otherwise = canonicalId(band.otherwise, 'band otherwise');
            const values = [...cases.map((entry) => entry.value), otherwise];
            if (new Set(values).size !== values.length)
              throw malformed('list figures band values must be unique');
            bandValues.set(figureId, new Set(values));
            return Object.freeze({
              cases: Object.freeze(cases),
              figureId,
              of,
              otherwise,
            });
          },
        );
  const latest =
    figures.latest === undefined
      ? undefined
      : list(figures.latest, 'latest', 1, 2).map(
          (entry): SharedListFigureLatest => {
            const latestFigure = record(entry, 'latest', [
              'byFieldId',
              'figureId',
              'label',
              'rows',
              'valueFieldId',
              'within',
            ]);
            const figureId = declare(latestFigure.figureId);
            const label = record(latestFigure.label, 'latest label', [
              'fieldId',
              'queryId',
            ]);
            const rows = record(latestFigure.rows, 'latest rows', [
              'matchFieldId',
              'queryId',
            ]);
            return Object.freeze({
              byFieldId: canonicalId(
                latestFigure.byFieldId,
                'latest byFieldId',
              ),
              figureId,
              label: Object.freeze({
                fieldId: canonicalId(label.fieldId, 'label fieldId'),
                queryId: canonicalId(label.queryId, 'label queryId'),
              }),
              rows: Object.freeze({
                matchFieldId: canonicalId(
                  rows.matchFieldId,
                  'rows matchFieldId',
                ),
                queryId: canonicalId(rows.queryId, 'rows queryId'),
              }),
              valueFieldId: canonicalId(
                latestFigure.valueFieldId,
                'latest valueFieldId',
              ),
              within: parseWithin(latestFigure.within),
            });
          },
        );
  const keep =
    figures.keep === undefined
      ? undefined
      : (() => {
          const kept = record(figures.keep, 'keep', ['figureId', 'values']);
          const figureId = canonicalId(kept.figureId, 'keep figureId');
          const values = strings(kept.values, 'keep values', 4, true);
          const declared = bandValues.get(figureId);
          if (!declared || !values.every((entry) => declared.has(entry)))
            throw malformed('list figures keep holds values of one band');
          return Object.freeze({ figureId, values });
        })();
  return Object.freeze({
    ...(bands ? { bands: Object.freeze(bands) } : {}),
    ...(keep ? { keep } : {}),
    ...(latest ? { latest: Object.freeze(latest) } : {}),
    sums: Object.freeze(sums),
    ...(totals ? { totals: Object.freeze(totals) } : {}),
  });
}

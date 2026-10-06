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

/**
 * Only rows whose parent holds a value: the parent through the rows' relation
 * to it, or the record whose id the rows hold in one of their own text fields
 * (`referenceFieldId`), as a stock balance holds its location (LOCATIONS).
 */
export type SharedListFigureWithin = {
  readonly fieldId: string;
  readonly queryId: string;
  readonly values: readonly string[];
} & (
  | { readonly relationId: string; readonly referenceFieldId?: never }
  | { readonly referenceFieldId: string; readonly relationId?: never }
);

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

/**
 * A listed row's exact decimal, a canonical decimal, or a number figure
 * computed before the band (CATALOG-EXTRAS), compared with.
 */
export type SharedListFigureThreshold =
  | { readonly fieldId: string }
  | { readonly figureId: string }
  | { readonly value: string };

/** The listed row's own value of an enumeration is one of these. */
export interface SharedListFigureWhen {
  readonly fieldId: string;
  readonly values: readonly string[];
}

export interface SharedListFigureBandCase {
  readonly atMost?: SharedListFigureThreshold;
  readonly below?: SharedListFigureThreshold;
  readonly value: string;
  readonly when?: SharedListFigureWhen;
}

/**
 * What a choice takes (CATALOG-EXTRAS): an operand, or a percentage of one
 * by the List's own company's exact decimal, read through a list query of
 * the companies.
 */
export type SharedListFigureChoiceValue =
  | SharedListFigureOperand
  | {
      readonly percent: {
        readonly company: {
          readonly fieldId: string;
          readonly queryId: string;
        };
        readonly of: SharedListFigureOperand;
      };
    };

/**
 * Per row, the first case whose values hold the row's own value of an
 * enumeration (`byFieldId`), else `otherwise`; a missing value is unstated.
 */
export interface SharedListFigureChoice {
  readonly byFieldId: string;
  readonly cases: readonly {
    readonly value?: SharedListFigureChoiceValue;
    readonly values: readonly string[];
  }[];
  readonly figureId: string;
  readonly otherwise?: SharedListFigureChoiceValue;
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
  readonly choices?: readonly SharedListFigureChoice[];
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
    ...(figures.choices ?? []).map(
      (choice) => [choice.figureId, 'number'] as const,
    ),
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
  const taken = (value: SharedListFigureChoiceValue | undefined) =>
    value === undefined
      ? []
      : 'percent' in value
        ? field(value.percent.of)
        : field(value);
  return [
    ...(figures.choices ?? []).flatMap((choice) => [
      choice.byFieldId,
      ...choice.cases.flatMap((entry) => taken(entry.value)),
      ...taken(choice.otherwise),
    ]),
    ...(figures.totals ?? []).flatMap((total) =>
      [...total.plus, ...total.minus].flatMap(field),
    ),
    ...(figures.bands ?? []).flatMap((band) =>
      band.cases.flatMap((entry) =>
        entry.when
          ? [entry.when.fieldId]
          : field((entry.below ?? entry.atMost)!),
      ),
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

function parseWithin(
  value: ImmutableJsonValue | undefined,
): SharedListFigureWithin {
  // A parent through a relation, or through a reference field: exactly one.
  const reference = isRecord(value) && Object.hasOwn(value, 'referenceFieldId');
  const within = record(value, 'within', [
    'fieldId',
    'queryId',
    reference ? 'referenceFieldId' : 'relationId',
    'values',
  ]);
  const common = {
    fieldId: canonicalId(within.fieldId, 'within fieldId'),
    queryId: canonicalId(within.queryId, 'within queryId'),
    values: strings(within.values, 'within values', 8, false),
  };
  return Object.freeze(
    reference
      ? {
          ...common,
          referenceFieldId: canonicalId(
            within.referenceFieldId,
            'within referenceFieldId',
          ),
        }
      : {
          ...common,
          relationId: canonicalId(within.relationId, 'within relationId'),
        },
  );
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
  numbers: ReadonlySet<string>,
): SharedListFigureThreshold {
  if (!isRecord(value)) throw malformed('list figures threshold is an object');
  if (Object.hasOwn(value, 'figureId')) {
    assertExactKeys(value, ['figureId']);
    const figureId = canonicalId(value.figureId, 'threshold figureId');
    if (!numbers.has(figureId))
      throw malformed('list figures threshold names a figure before it');
    return Object.freeze({ figureId });
  }
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

function parseWhen(value: ImmutableJsonValue | undefined) {
  const when = record(value, 'when', ['fieldId', 'values']);
  return Object.freeze({
    fieldId: canonicalId(when.fieldId, 'when fieldId'),
    values: strings(when.values, 'when values', 8, false),
  });
}

/** A choice's value: an operand, or a percentage of one by the company's. */
function parseChoiceValue(
  value: ImmutableJsonValue | undefined,
  numbers: ReadonlySet<string>,
): SharedListFigureChoiceValue {
  const operand = (entry: ImmutableJsonValue) => {
    const parsed = parseOperand(entry);
    if ('figureId' in parsed && !numbers.has(parsed.figureId))
      throw malformed('list figures choice takes figures declared before it');
    return parsed;
  };
  if (isRecord(value) && Object.hasOwn(value, 'percent')) {
    assertExactKeys(value, ['percent']);
    const percent = record(value.percent, 'choice percent', ['company', 'of']);
    const company = record(percent.company, 'choice company', [
      'fieldId',
      'queryId',
    ]);
    return Object.freeze({
      percent: Object.freeze({
        company: Object.freeze({
          fieldId: canonicalId(company.fieldId, 'company fieldId'),
          queryId: canonicalId(company.queryId, 'company queryId'),
        }),
        of: operand(percent.of as ImmutableJsonValue),
      }),
    });
  }
  if (value === undefined)
    throw malformed('list figures choice value is an object');
  return operand(value);
}

/**
 * What one sum adds up -- its rows, their parent and related rows, and which
 * of them it adds -- from a member whose keys the caller has closed. `rows`
 * adds a quantity, `related` related rows, `remaining` both: exactly those.
 */
function parseSumParts(
  sum: Readonly<Record<string, ImmutableJsonValue | undefined>>,
): Omit<SharedListFigureSum, 'figureId'> {
  const rows = record(
    sum.rows,
    'rows',
    ['matchFieldId', 'queryId'],
    ['quantityFieldId'],
  );
  if (sum.sum !== 'rows' && sum.sum !== 'related' && sum.sum !== 'remaining')
    throw malformed('list figures sum is rows, related or remaining');
  if (
    (rows.quantityFieldId !== undefined) !== (sum.sum !== 'related') ||
    (sum.related !== undefined) !== (sum.sum !== 'rows')
  )
    throw malformed('list figures sum names exactly the parts it adds');
  return {
    ...(sum.related === undefined
      ? {}
      : { related: parseSharedListFigureRelated(sum.related) }),
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
    ...(sum.within === undefined ? {} : { within: parseWithin(sum.within) }),
  };
}

/** Rows pointing at other rows through a relation, and the quantity added. */
export function parseSharedListFigureRelated(
  value: ImmutableJsonValue | undefined,
): SharedListFigureRelated {
  const related = record(value, 'related', [
    'fieldId',
    'queryId',
    'relationId',
  ]);
  return Object.freeze({
    fieldId: canonicalId(related.fieldId, 'related fieldId'),
    queryId: canonicalId(related.queryId, 'related queryId'),
    relationId: canonicalId(related.relationId, 'related relationId'),
  });
}

/**
 * One part of an item's free stock in a List's supply (SUPPLY-WARNINGS): a
 * sum's parts without an id of its own, with the same closed contract.
 */
export function parseSharedListSupplySum(
  value: ImmutableJsonValue | undefined,
): Omit<SharedListFigureSum, 'figureId'> {
  const sum = record(
    value,
    'supply sum',
    ['rows', 'sum'],
    ['related', 'within'],
  );
  return Object.freeze(parseSumParts(sum));
}

/**
 * The closed request contract. Beyond each member's shape it proves what the
 * statement relies on: unique figure ids, a sum naming exactly the parts it
 * adds, choices, totals and bands over figures declared before them, and a
 * `keep` of values its band declares -- so the executor never meets a
 * dangling id.
 */
export function parseSharedListFigures(
  value: ImmutableJsonValue,
): SharedListFigures {
  const figures = record(
    value,
    'argument',
    ['sums'],
    ['bands', 'choices', 'keep', 'latest', 'totals'],
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
      const parts = parseSumParts(sum);
      numbers.add(figureId);
      return Object.freeze({ figureId, ...parts });
    },
  );
  // CATALOG-EXTRAS: computed after the sums and before the totals, so a
  // total may add a choice and a choice may take a sum.
  const choices =
    figures.choices === undefined
      ? undefined
      : list(figures.choices, 'choices', 1, 2).map(
          (entry): SharedListFigureChoice => {
            const choice = record(
              entry,
              'choice',
              ['byFieldId', 'cases', 'figureId'],
              ['otherwise'],
            );
            const figureId = declare(choice.figureId);
            const taken = new Set<string>();
            const cases = list(choice.cases, 'choice cases', 1, 4).map(
              (candidate) => {
                const entry = record(
                  candidate,
                  'choice case',
                  ['values'],
                  ['value'],
                );
                const values = strings(
                  entry.values,
                  'choice case values',
                  8,
                  false,
                );
                for (const option of values) {
                  if (taken.has(option))
                    throw malformed(
                      'list figures choice values must be unique',
                    );
                  taken.add(option);
                }
                return Object.freeze({
                  ...(entry.value === undefined
                    ? {}
                    : { value: parseChoiceValue(entry.value, numbers) }),
                  values,
                });
              },
            );
            const otherwise =
              choice.otherwise === undefined
                ? undefined
                : parseChoiceValue(choice.otherwise, numbers);
            numbers.add(figureId);
            return Object.freeze({
              byFieldId: canonicalId(choice.byFieldId, 'choice byFieldId'),
              cases: Object.freeze(cases),
              figureId,
              ...(otherwise ? { otherwise } : {}),
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
                  ['atMost', 'below', 'when'],
                );
                if (
                  [entry.below, entry.atMost, entry.when].filter(
                    (test) => test !== undefined,
                  ).length !== 1
                )
                  throw malformed(
                    'list figures band case holds exactly one test',
                  );
                return Object.freeze({
                  value: canonicalId(entry.value, 'band case value'),
                  ...(entry.below === undefined
                    ? {}
                    : { below: parseThreshold(entry.below, numbers) }),
                  ...(entry.atMost === undefined
                    ? {}
                    : { atMost: parseThreshold(entry.atMost, numbers) }),
                  ...(entry.when === undefined
                    ? {}
                    : { when: parseWhen(entry.when) }),
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
    ...(choices ? { choices: Object.freeze(choices) } : {}),
    ...(keep ? { keep } : {}),
    ...(latest ? { latest: Object.freeze(latest) } : {}),
    sums: Object.freeze(sums),
    ...(totals ? { totals: Object.freeze(totals) } : {}),
  });
}

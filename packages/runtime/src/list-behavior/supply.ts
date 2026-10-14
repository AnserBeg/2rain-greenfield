import type { ImmutableJsonValue } from '../request-runtime-view.js';
import { assertExactKeys, isRecord, malformed } from './contract.js';
import {
  parseSharedListFigureRelated,
  parseSharedListSupplySum,
  type SharedListFigureRelated,
  type SharedListSumParts,
} from './figures.js';

/**
 * LIST SUPPLY (SUPPLY-WARNINGS, owner ruling R1). Per listed row, beside the
 * progress it extends and in the same statement, before the count and the
 * page window: what the `coverage` rows pointing at each of the row's lines
 * still hold through their related rows (a line's reservations and what their
 * balances still hold), and what the lines are short of now. A line's
 * uncovered quantity is its open quantity -- its progress quantity less its
 * done rows' -- less its coverage, never below zero. The free stock of the
 * item a line names in `itemFieldId` is the `free.plus` sums less the
 * `free.minus` sums over rows holding that item's id; per item it is
 * allocated, never below zero, to the row's uncovered quantity, and what it
 * cannot cover is short. `covered` is the coverage of lines with something
 * open, each at most what is open; `short` is stated in `shortIn` states and
 * is 0 in any other. `keep` narrows the set to rows with something covered,
 * or something short, so a tab counts, pages and exports exactly that set.
 *
 * Every id is resolved by the gateway against the pinned query catalog and by
 * the executor against the pinned compiled storage.
 */
export type SharedListSupplySum = SharedListSumParts;

export interface SharedListSupply {
  readonly coverage: {
    readonly queryId: string;
    readonly related: SharedListFigureRelated;
    readonly relationId: string;
  };
  readonly free: {
    readonly minus: readonly SharedListSupplySum[];
    readonly plus: readonly SharedListSupplySum[];
  };
  readonly itemFieldId: string;
  readonly keep?: 'covered' | 'short';
  readonly outputs: { readonly covered: string; readonly short: string };
  readonly shortIn?: {
    readonly fieldId: string;
    readonly values: readonly string[];
  };
}

const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function canonicalId(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 5 ||
    value.length > 180 ||
    !canonicalIdPattern.test(value)
  )
    throw malformed(`list supply ${name} must be a canonical ID`);
  return value;
}

function closed(
  value: ImmutableJsonValue | undefined,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, ImmutableJsonValue | undefined>> {
  if (!isRecord(value)) throw malformed(`list supply ${name} is an object`);
  assertExactKeys(value, [...required, ...optional], true);
  if (required.some((key) => !Object.hasOwn(value, key)))
    throw malformed(`list supply ${name} is missing a required member`);
  return value;
}

function sums(
  value: ImmutableJsonValue | undefined,
  name: string,
  minimum: number,
): readonly SharedListSupplySum[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 4)
    throw malformed(`list supply ${name} holds ${String(minimum)} to 4 sums`);
  return Object.freeze(
    (value as readonly ImmutableJsonValue[]).map(parseSharedListSupplySum),
  );
}

/**
 * The closed request contract: every member's shape, distinct outputs, one to
 * eight distinct short states, and a `keep` of covered or short only.
 */
export function parseSharedListSupply(
  value: ImmutableJsonValue,
): SharedListSupply {
  const supply = closed(
    value,
    'argument',
    ['coverage', 'free', 'itemFieldId', 'outputs'],
    ['keep', 'shortIn'],
  );
  const coverage = closed(supply.coverage, 'coverage', [
    'queryId',
    'related',
    'relationId',
  ]);
  const free = closed(supply.free, 'free', ['minus', 'plus']);
  const outputs = closed(supply.outputs, 'outputs', ['covered', 'short']);
  const covered = canonicalId(outputs.covered, 'covered output');
  const short = canonicalId(outputs.short, 'short output');
  if (covered === short)
    throw malformed('list supply outputs must be two distinct ids');
  if (
    supply.keep !== undefined &&
    supply.keep !== 'covered' &&
    supply.keep !== 'short'
  )
    throw malformed('list supply keep is covered or short');
  const shortIn =
    supply.shortIn === undefined
      ? undefined
      : (() => {
          const states = closed(supply.shortIn, 'shortIn', [
            'fieldId',
            'values',
          ]);
          const values = states.values;
          if (
            !Array.isArray(values) ||
            values.length === 0 ||
            values.length > 8 ||
            values.some(
              (entry) =>
                typeof entry !== 'string' ||
                entry.length === 0 ||
                entry.length > 240,
            ) ||
            new Set(values).size !== values.length
          )
            throw malformed('list supply shortIn holds one to eight values');
          return Object.freeze({
            fieldId: canonicalId(states.fieldId, 'shortIn fieldId'),
            values: Object.freeze([...(values as string[])]),
          });
        })();
  return Object.freeze({
    coverage: Object.freeze({
      queryId: canonicalId(coverage.queryId, 'coverage queryId'),
      related: parseSharedListFigureRelated(coverage.related),
      relationId: canonicalId(coverage.relationId, 'coverage relationId'),
    }),
    free: Object.freeze({
      minus: sums(free.minus, 'free minus', 0),
      plus: sums(free.plus, 'free plus', 1),
    }),
    itemFieldId: canonicalId(supply.itemFieldId, 'itemFieldId'),
    ...(supply.keep === undefined ? {} : { keep: supply.keep }),
    outputs: Object.freeze({ covered, short }),
    ...(shortIn ? { shortIn } : {}),
  });
}

/**
 * Every query the supply reads, with the fields its rows must select there
 * and the relations it follows from them -- for one current-policy decision
 * per query and request.
 */
export function sharedListSupplyReads(supply: SharedListSupply): ReadonlyMap<
  string,
  {
    readonly fieldIds: ReadonlySet<string>;
    readonly relationIds: ReadonlySet<string>;
  }
> {
  const reads = new Map<
    string,
    { fieldIds: Set<string>; relationIds: Set<string> }
  >();
  const use = (
    queryId: string,
    fieldIds: readonly string[],
    relationId?: string,
  ) => {
    const entry = reads.get(queryId) ?? {
      fieldIds: new Set<string>(),
      relationIds: new Set<string>(),
    };
    for (const fieldId of fieldIds) entry.fieldIds.add(fieldId);
    if (relationId) entry.relationIds.add(relationId);
    reads.set(queryId, entry);
  };
  use(supply.coverage.queryId, [], supply.coverage.relationId);
  use(
    supply.coverage.related.queryId,
    [supply.coverage.related.fieldId],
    supply.coverage.related.relationId,
  );
  for (const sum of [...supply.free.plus, ...supply.free.minus]) {
    use(sum.rows.queryId, [
      sum.rows.matchFieldId,
      ...(sum.rows.quantityFieldId ? [sum.rows.quantityFieldId] : []),
      // A parent reached through a reference field is joined on the record
      // id the rows hold: the rows' query must select the field holding it.
      ...(sum.within?.referenceFieldId ? [sum.within.referenceFieldId] : []),
    ]);
    if (sum.within)
      use(sum.within.queryId, [sum.within.fieldId], sum.within.relationId);
    if (sum.related)
      use(sum.related.queryId, [sum.related.fieldId], sum.related.relationId);
  }
  return reads;
}

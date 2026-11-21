import type { ReportCurrencyBinding } from './schemas.js';

export const GROUPED_AGGREGATE_PROFILE = 'northstar.query-aggregate-profile/v2';
export const GROUPED_RESULT_VERSION = 'northstar.grouped-query-result/v1';

export interface GroupedMeasure {
  readonly id: string;
  readonly operator: 'count' | 'sum';
  readonly fieldId?: string;
  readonly scale: number;
  readonly currency?: ReportCurrencyBinding;
}

export interface GroupedCell {
  readonly measureId: string;
  readonly value: string;
  readonly recordsWithoutMeasure: number;
}

export type CurrencyPartition =
  | { kind: 'unitless' }
  | { kind: 'noCurrency' }
  | { kind: 'currency'; code: string };

export interface GroupedRow {
  readonly keys: readonly (string | null)[];
  readonly partition: CurrencyPartition;
  readonly cells: readonly GroupedCell[];
}

type Fact = Readonly<Record<string, string | null>>;

function partitionFor(
  binding: ReportCurrencyBinding | undefined,
  fact: Fact,
): CurrencyPartition {
  if (!binding) return { kind: 'unitless' };
  if (binding.kind === 'fixed')
    return { kind: 'currency', code: binding.currencyCode };
  const code = binding.codes.find(
    (candidate) => candidate === fact[binding.fieldId],
  );
  return code ? { kind: 'currency', code } : { kind: 'noCurrency' };
}

function scaled(value: string, scale: number): bigint {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))
    throw new RangeError('Invalid report decimal');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale && /[1-9]/u.test(fraction.slice(scale)))
    throw new RangeError('Invalid report scale');
  return BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0'));
}

function decimal(value: bigint, scale: number): string {
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  if (digits.length > 38) throw new RangeError('Report precision overflow');
  const sign = value < 0n ? '-' : '';
  return (
    sign +
    (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits)
  );
}

/** Reference result for a complete, already-authorized set of single-record facts.
 * The provider compares SQL groups and partition totals against this contract.
 */
export function evaluateGroupedFacts(
  dimensions: readonly string[],
  measures: readonly GroupedMeasure[],
  facts: readonly Fact[],
) {
  const binding = measures.find((m) => m.currency)?.currency;
  if (
    measures.some(
      (m) =>
        m.currency && JSON.stringify(m.currency) !== JSON.stringify(binding),
    )
  )
    throw new RangeError('Incompatible currency bindings');
  const group = (
    keys: readonly (string | null)[],
    partition: CurrencyPartition,
  ) => ({
    keys,
    partition,
    cells: measures.map(() => ({ sum: 0n, missing: 0 })),
  });
  type Group = ReturnType<typeof group>;
  const groups = new Map<string, Group>();
  const totals = new Map<string, Group>();
  const entry = (
    map: Map<string, Group>,
    keys: readonly (string | null)[],
    partition: CurrencyPartition,
  ) => {
    const id = JSON.stringify([partition, keys]);
    const row = map.get(id) ?? group(keys, partition);
    map.set(id, row);
    return row;
  };
  if (binding?.kind !== 'stored') entry(totals, [], partitionFor(binding, {}));
  for (const fact of facts) {
    const partition = partitionFor(binding, fact);
    const rows = [
      entry(
        groups,
        dimensions.map((id) => fact[id] ?? null),
        partition,
      ),
      entry(totals, [], partition),
    ];
    for (const [i, m] of measures.entries()) {
      const value = m.operator === 'count' ? '1' : fact[m.fieldId!];
      for (const row of rows) {
        if (value == null) row.cells[i]!.missing++;
        else row.cells[i]!.sum += scaled(value, m.scale);
      }
    }
  }
  const render = (map: Map<string, Group>): GroupedRow[] =>
    [...map.values()].map(({ keys, partition, cells }) => ({
      keys,
      partition,
      cells: cells.map((cell, i) => ({
        measureId: measures[i]!.id,
        value: decimal(cell.sum, measures[i]!.scale),
        recordsWithoutMeasure: cell.missing,
      })),
    }));
  return {
    schemaVersion: GROUPED_RESULT_VERSION,
    groups: render(groups),
    totals: render(totals),
  };
}

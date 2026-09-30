import { parseExact } from './commercial-amounts.js';

/** Reduced rationals preserve fractional cost through every relief/replay. */
export interface Fraction {
  readonly n: bigint;
  readonly d: bigint;
}
export const zero: Fraction = { n: 0n, d: 1n };
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}
export function fraction(n: bigint, d = 1n): Fraction {
  if (!d) throw new Error('Valuation division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
export const add = (a: Fraction, b: Fraction) =>
  fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const neg = (a: Fraction) => fraction(-a.n, a.d);
export const multiply = (a: Fraction, b: Fraction) =>
  fraction(a.n * b.n, a.d * b.d);
export const divide = (a: Fraction, b: Fraction) =>
  fraction(a.n * b.d, a.d * b.n);
export const positive = (a: Fraction) => a.n > 0n;
export function exact(value: unknown): Fraction {
  const parsed = parseExact(value);
  if (!parsed || parsed.scale > 18)
    throw new Error('Invalid valuation decimal');
  return fraction(parsed.units, 10n ** BigInt(parsed.scale));
}
export function display(a: Fraction, decimals: number, trim = false): string {
  const scale = 10n ** BigInt(decimals);
  const magnitude = a.n < 0n ? -a.n : a.n;
  let rounded = (magnitude * scale) / a.d;
  if (((magnitude * scale) % a.d) * 2n >= a.d) rounded++;
  const tail = (rounded % scale).toString().padStart(decimals, '0');
  const decimal = trim ? tail.replace(/0+$/u, '') : tail;
  return `${a.n < 0n && rounded ? '-' : ''}${rounded / scale}${decimal ? `.${decimal}` : ''}`;
}
export interface CostPool {
  quantity: Fraction;
  value: Fraction;
}
export interface ValuationEffect {
  quantity: Fraction;
  unvalued: Fraction;
  pools: Map<string, CostPool>;
}
export interface CostMovement {
  readonly id: string;
  readonly item: string;
  readonly unit: string;
  readonly quantity: string;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceLine: string;
  readonly role: string;
  readonly reversal: string | null;
}
export interface ReceiptCost {
  readonly item: string;
  readonly unit: string;
  readonly currency: string | null;
  readonly unitCost: string | null;
  readonly known: boolean;
}
export interface ItemValuation extends ValuationEffect {
  readonly complete: boolean;
}
export interface ValuationReplay {
  readonly items: ReadonlyMap<string, ItemValuation>;
  readonly effects: ReadonlyMap<string, ValuationEffect>;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function compareCostMovements(a: CostMovement, b: CostMovement): number {
  for (const key of [
    'effectiveAt',
    'recordedAt',
    'sourceType',
    'sourceId',
    'sourceLine',
    'role',
    'id',
  ] as const) {
    const result = compare(a[key], b[key]);
    if (result) return result;
  }
  return 0;
}
const emptyEffect = (quantity = zero): ValuationEffect => ({
  quantity,
  unvalued: zero,
  pools: new Map(),
});
const scaledEffect = (
  effect: ValuationEffect,
  ratio: Fraction,
): ValuationEffect => ({
  quantity: multiply(effect.quantity, ratio),
  unvalued: multiply(effect.unvalued, ratio),
  pools: new Map(
    [...effect.pools].map(([currency, pool]) => [
      currency,
      {
        quantity: multiply(pool.quantity, ratio),
        value: multiply(pool.value, ratio),
      },
    ]),
  ),
});

/** Quantity-only facts plus captured receipt costs; no stored balance is healed. */
export function replayInventoryValue(
  movements: readonly CostMovement[],
  receipts: ReadonlyMap<string, ReceiptCost>,
): ValuationReplay {
  const items = new Map<string, ItemValuation>();
  const effects = new Map<string, ValuationEffect>();
  const movementById = new Map(
    movements.map((movement) => [movement.id, movement]),
  );
  const transfers = new Map<string, CostMovement[]>();
  for (const movement of movements)
    if (movement.role === 'transfer') {
      const key = JSON.stringify([
        movement.item,
        movement.sourceType,
        movement.sourceId,
        movement.sourceLine,
      ]);
      transfers.set(key, [...(transfers.get(key) ?? []), movement]);
    }
  for (const group of transfers.values())
    if (
      group.length !== 2 ||
      add(exact(group[0]!.quantity), exact(group[1]!.quantity)).n !== 0n ||
      group[0]!.unit !== group[1]!.unit
    )
      throw new Error('Incomplete valuation transfer');
  for (const movement of [...movements].sort(compareCostMovements)) {
    if (effects.has(movement.id))
      throw new Error('Duplicate valuation movement');
    const quantity = exact(movement.quantity);
    const state = items.get(movement.item) ?? {
      ...emptyEffect(),
      complete: true,
    };
    items.set(movement.item, state);
    // Transfers only change location; this read pools company stock.
    if (movement.role === 'transfer') {
      effects.set(movement.id, emptyEffect());
      continue;
    }
    let effect: ValuationEffect;
    if (movement.reversal) {
      const original = effects.get(movement.reversal);
      const source = movementById.get(movement.reversal);
      if (
        !original ||
        !original.quantity.n ||
        source?.item !== movement.item ||
        source.unit !== movement.unit ||
        original.quantity.n * quantity.n >= 0n
      )
        throw new Error('Invalid valuation compensation');
      effect = scaledEffect(original, divide(quantity, original.quantity));
    } else if (positive(quantity)) {
      const receipt =
        movement.sourceType === 'goodsReceipt'
          ? receipts.get(
              JSON.stringify([movement.sourceId, movement.sourceLine]),
            )
          : undefined;
      if (
        receipt &&
        (receipt.item !== movement.item || receipt.unit !== movement.unit)
      )
        throw new Error('Receipt valuation lineage mismatch');
      if (
        receipt?.known &&
        receipt.currency &&
        /^[A-Z]{3}$/u.test(receipt.currency) &&
        receipt.unitCost !== null
      ) {
        const cost = exact(receipt.unitCost);
        if (cost.n < 0n) throw new Error('Negative receipt cost');
        effect = {
          quantity,
          unvalued: zero,
          pools: new Map([
            [receipt.currency, { quantity, value: multiply(quantity, cost) }],
          ]),
        };
      } else effect = { ...emptyEffect(quantity), unvalued: quantity };
    } else if (quantity.n < 0n && positive(state.quantity) && state.complete) {
      effect = scaledEffect(state, divide(quantity, state.quantity));
    } else effect = { ...emptyEffect(quantity), unvalued: quantity };
    state.quantity = add(state.quantity, effect.quantity);
    state.unvalued = add(state.unvalued, effect.unvalued);
    for (const [currency, change] of effect.pools) {
      const pool = state.pools.get(currency) ?? { quantity: zero, value: zero };
      state.pools.set(currency, {
        quantity: add(pool.quantity, change.quantity),
        value: add(pool.value, change.value),
      });
    }
    // A correction can remove original cost after other units were relieved.
    // Never claim money from negative coverage, even when total stock is positive.
    const complete =
      state.complete &&
      state.quantity.n >= 0n &&
      state.unvalued.n >= 0n &&
      [...state.pools.values()].every(
        (pool) => pool.quantity.n >= 0n && pool.value.n >= 0n,
      );
    items.set(movement.item, { ...state, complete });
    effects.set(movement.id, effect);
  }
  return { items, effects };
}
export function itemCostFigures(
  state: ItemValuation | undefined,
): Record<string, string | null> {
  if (!state)
    return {
      on_hand: '0',
      average_cost: null,
      inventory_value: '0.00',
      unvalued_quantity: '0',
    };
  const currencies = [...state.pools].sort(([a], [b]) => compare(a, b));
  return {
    on_hand: display(state.quantity, 18, true),
    average_cost: state.complete
      ? currencies
          .filter(([, pool]) => positive(pool.quantity))
          .map(
            ([currency, pool]) =>
              `${currency} ${display(divide(pool.value, pool.quantity), 6, true)}`,
          )
          .join(' · ') || null
      : null,
    inventory_value: state.complete
      ? currencies
          .filter(([, pool]) => positive(pool.quantity))
          .map(([currency, pool]) => `${currency} ${display(pool.value, 2)}`)
          .join(' · ') || '0.00'
      : null,
    unvalued_quantity: state.complete
      ? display(state.unvalued, 18, true)
      : 'Unstated: incomplete cost coverage',
  };
}

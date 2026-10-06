import {
  add,
  divide,
  exact,
  multiply,
  neg,
  zero,
  compareCostMovements,
  type Fraction,
  type CostMovement,
  type ReceiptCost,
} from './inventory-valuation.js';

export interface BilledReceiptSource {
  readonly orderLine: string;
  readonly item: string;
  readonly unit: string;
}
export interface LandedBill {
  readonly id: string;
  readonly date: string;
  readonly currency: string;
  readonly charges: string;
  readonly live: boolean;
}
export interface LandedBillLine {
  readonly bill: string;
  readonly orderLine: string;
  readonly item: string;
  readonly unit: string;
  readonly quantity: string;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Quantity matching establishes billed provenance; stock itself remains moving average. */
export function allocateLandedCharges(
  movements: readonly CostMovement[],
  receipts: ReadonlyMap<string, ReceiptCost>,
  sources: ReadonlyMap<string, BilledReceiptSource>,
  bills: readonly LandedBill[],
  lines: readonly LandedBillLine[],
) {
  const byId = new Map(movements.map((m) => [m.id, m]));
  const origins = new Map<string, string>();
  const net = new Map<string, Fraction>();
  for (const movement of [...movements].sort(compareCostMovements)) {
    const origin = movement.reversal
      ? origins.get(movement.reversal)
      : movement.id;
    if (!origin) throw new Error('Landed receipt compensation is incomplete');
    origins.set(movement.id, origin);
    if (byId.get(origin)?.sourceType === 'goodsReceipt')
      net.set(origin, add(net.get(origin) ?? zero, exact(movement.quantity)));
  }
  const portions = [...movements]
    .sort(compareCostMovements)
    .filter(
      (m) =>
        m.sourceType === 'goodsReceipt' &&
        !m.reversal &&
        exact(m.quantity).n > 0n,
    )
    .map((m) => {
      const quantity = net.get(m.id)!;
      if (quantity.n < 0n || add(exact(m.quantity), neg(quantity)).n < 0n)
        throw new Error('Invalid net billed receipt quantity');
      const source = sources.get(m.sourceLine);
      if (!source || source.item !== m.item || source.unit !== m.unit)
        throw new Error('Billed receipt lineage is incomplete');
      return {
        movement: m,
        source,
        quantity,
        remaining: quantity,
        cost: receipts.get(JSON.stringify([m.sourceId, m.sourceLine])),
      };
    });
  const netCharges = new Map<string, Fraction>();
  const invalidItems = new Map<string, string>();
  const chargedItems = new Set<string>();
  for (const bill of [...bills].sort(
    (a, b) => compare(a.date, b.date) || compare(a.id, b.id),
  )) {
    if (!bill.live) continue;
    const charges = exact(bill.charges);
    if (charges.n < 0n) throw new Error('Negative landed charges');
    const billed = lines.filter((l) => l.bill === bill.id);
    if (!billed.length) throw new Error('Live landed bill lines are absent');
    const affected = new Set(billed.map((l) => l.item));
    let reason: string | null = null;
    const matched: { origin: string; quantity: Fraction; value: Fraction }[] =
      [];
    for (const line of billed) {
      let required = exact(line.quantity);
      if (required.n <= 0n) throw new Error('Invalid landed billed quantity');
      for (const part of portions) {
        if (part.source.orderLine !== line.orderLine || part.remaining.n <= 0n)
          continue;
        if (part.source.item !== line.item || part.source.unit !== line.unit)
          throw new Error('Landed bill item or unit differs from its receipt');
        const take =
          add(part.remaining, neg(required)).n < 0n ? part.remaining : required;
        part.remaining = add(part.remaining, neg(take));
        required = add(required, neg(take));
        const cost = part.cost;
        let value = zero;
        if (!cost?.known || cost.unitCost === null || cost.currency === null)
          reason = 'receipt cost is absent';
        else if (cost.currency !== bill.currency)
          reason = 'receipt currency differs';
        else {
          const unitCost = exact(cost.unitCost);
          if (unitCost.n < 0n)
            throw new Error('Negative receipt allocation basis');
          value = multiply(take, unitCost);
        }
        matched.push({ origin: part.movement.id, quantity: take, value });
        if (required.n === 0n) break;
      }
      if (required.n > 0n) reason = 'billed receipt quantity is uncovered';
    }
    // Zero-charge bills still consume quantity provenance, but add no uncertain money.
    if (charges.n === 0n) continue;
    const basis = matched.reduce((sum, p) => add(sum, p.value), zero);
    if (basis.n <= 0n) reason ??= 'actual receipt value is zero';
    if (reason) {
      for (const item of affected) invalidItems.set(item, reason);
      continue;
    }
    for (const part of matched) {
      const share = multiply(charges, divide(part.value, basis));
      netCharges.set(
        part.origin,
        add(netCharges.get(part.origin) ?? zero, share),
      );
    }
    for (const item of affected) chargedItems.add(item);
  }
  // A compensation removes its original effect. Gross up the original inflow
  // so its net surviving units retain exactly the allocated charge.
  const grossCharges = new Map<string, Fraction>();
  for (const [id, charge] of netCharges)
    grossCharges.set(
      id,
      multiply(charge, divide(exact(byId.get(id)!.quantity), net.get(id)!)),
    );
  return { grossCharges, invalidItems, chargedItems };
}

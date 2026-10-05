import { lineAmounts } from './commercial-amounts.js';
import {
  add,
  divide,
  display,
  exact,
  fraction,
  multiply,
  neg,
  zero,
  type Fraction,
  type CostMovement,
  type ValuationEffect,
  type ValuationReplay,
} from './inventory-valuation.js';

export interface RelievedCost extends ValuationEffect {
  readonly complete: boolean;
}
export interface ShipmentCostSource {
  readonly shipment: string;
  readonly orderLine: string;
  readonly item: string;
  readonly unit: string;
  readonly posted: boolean;
}
export interface OrderCostSource {
  readonly order: string;
  readonly item: string;
  readonly unit: string;
  readonly unitPrice: unknown;
  readonly discountPercent: unknown;
}
export const emptyRelief = (): RelievedCost => ({
  quantity: zero,
  unvalued: zero,
  pools: new Map(),
  complete: true,
});
export function sumRelief(a: RelievedCost, b: RelievedCost): RelievedCost {
  const pools = new Map(a.pools);
  for (const [currency, pool] of b.pools) {
    const old = pools.get(currency) ?? { quantity: zero, value: zero };
    pools.set(currency, {
      quantity: add(old.quantity, pool.quantity),
      value: add(old.value, pool.value),
    });
  }
  return {
    quantity: add(a.quantity, b.quantity),
    unvalued: add(a.unvalued, b.unvalued),
    pools,
    complete: a.complete && b.complete,
  };
}
export function scaleRelief(cost: RelievedCost, ratio: Fraction): RelievedCost {
  return {
    complete: cost.complete,
    quantity: multiply(cost.quantity, ratio),
    unvalued: multiply(cost.unvalued, ratio),
    pools: new Map(
      [...cost.pools].map(([currency, pool]) => [
        currency,
        {
          quantity: multiply(pool.quantity, ratio),
          value: multiply(pool.value, ratio),
        },
      ]),
    ),
  };
}

/** Costs follow posted shipment lineage, including the original-effect compensation. */
export function deriveShipmentCosts(
  movements: readonly CostMovement[],
  replay: ValuationReplay,
  sources: ReadonlyMap<string, ShipmentCostSource>,
  orderSources: ReadonlyMap<string, OrderCostSource>,
) {
  const shipmentLines = new Map<string, RelievedCost>();
  const shipments = new Map<string, RelievedCost>();
  const orderLines = new Map<string, RelievedCost>();
  const orders = new Map<string, RelievedCost>();
  const append = (
    map: Map<string, RelievedCost>,
    id: string,
    cost: RelievedCost,
  ) => map.set(id, sumRelief(map.get(id) ?? emptyRelief(), cost));
  for (const movement of movements) {
    if (movement.sourceType !== 'shipment') continue;
    const source = sources.get(movement.sourceLine);
    const order = source && orderSources.get(source.orderLine);
    const effect = replay.effects.get(movement.id);
    if (
      !source ||
      !order ||
      !effect ||
      !source.posted ||
      source.shipment !== movement.sourceId ||
      source.item !== movement.item ||
      source.unit !== movement.unit ||
      order.item !== movement.item ||
      order.unit !== movement.unit
    )
      throw new Error('Shipment cost lineage is incomplete');
    const relieved = scaleRelief(
      {
        ...effect,
        complete:
          replay.items.get(movement.item)?.complete === true &&
          replay.items.get(movement.item)?.landedComplete !== false,
      },
      fraction(-1n),
    );
    append(shipmentLines, movement.sourceLine, relieved);
    append(shipments, source.shipment, relieved);
    append(orderLines, source.orderLine, relieved);
    append(orders, order.order, relieved);
  }
  return { shipmentLines, shipments, orderLines, orders };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function relievedCostFigures(
  cost: RelievedCost,
): Record<string, string | null> {
  const pools = [...cost.pools]
    .filter(([, p]) => p.quantity.n || p.value.n)
    .sort(([a], [b]) => compare(a, b));
  return {
    cost_of_goods: cost.complete
      ? pools
          .map(([currency, pool]) => `${currency} ${display(pool.value, 2)}`)
          .join(' · ') || '0.00'
      : null,
    cost_unvalued_quantity: cost.complete
      ? display(cost.unvalued, 18, true)
      : null,
    cost_coverage: !cost.complete
      ? 'Unstated: incomplete cost coverage'
      : cost.quantity.n === 0n
        ? 'No net shipped quantity'
        : cost.unvalued.n !== 0n
          ? 'Unvalued quantity'
          : pools.length > 1
            ? 'Multiple cost currencies'
            : 'Fully valued',
  };
}

/** A margin needs all units valued in the document currency; zero known cost counts. */
export function productMargin(
  cost: RelievedCost,
  currency: string,
  revenue: Fraction | null,
): string | null {
  if (
    !cost.complete ||
    cost.unvalued.n !== 0n ||
    revenue === null ||
    cost.quantity.n <= 0n
  )
    return null;
  let value = zero;
  for (const [poolCurrency, pool] of cost.pools) {
    if (pool.quantity.n === 0n && pool.value.n === 0n) continue;
    if (poolCurrency !== currency) return null;
    value = add(value, pool.value);
  }
  return `${currency} ${display(add(revenue, neg(value)), 2)}`;
}

export function shippedProductRevenue(
  order: string,
  sources: ReadonlyMap<string, OrderCostSource>,
  costs: ReadonlyMap<string, RelievedCost>,
): Fraction | null {
  let revenue = zero;
  for (const [id, source] of sources) {
    if (source.order !== order) continue;
    const cost = costs.get(id);
    if (!cost || cost.quantity.n === 0n) continue;
    const amounts = lineAmounts({
      quantity: display(cost.quantity, 18, true),
      unitPrice: source.unitPrice,
      discountPercent: source.discountPercent,
      taxRatePercent: undefined,
    });
    if (!amounts) return null;
    revenue = add(revenue, fraction(amounts.amountCents, 100n));
  }
  return revenue;
}

export interface CostInvoice {
  readonly id: string;
  readonly date: string;
  readonly live: boolean;
}
export interface CostInvoiceLine {
  readonly invoice: string;
  readonly orderLine: string;
  readonly quantity: string;
  readonly amount: string;
}
export interface InvoiceCost {
  readonly cost: RelievedCost;
  readonly revenue: Fraction;
  readonly coverage: string | null;
}

/** Live invoice quantities consume net shipment coverage per order line, not FIFO cost layers. */
export function deriveInvoiceCosts(
  invoices: readonly CostInvoice[],
  lines: readonly CostInvoiceLine[],
  shipped: ReadonlyMap<string, RelievedCost>,
): ReadonlyMap<string, InvoiceCost> {
  const used = new Map<string, Fraction>();
  const result = new Map<string, InvoiceCost>();
  for (const invoice of [...invoices].sort(
    (a, b) => compare(a.date, b.date) || compare(a.id, b.id),
  )) {
    if (!invoice.live) continue;
    let cost = emptyRelief();
    let revenue = zero;
    let coverage: string | null = null;
    const billedLines = lines.filter((l) => l.invoice === invoice.id);
    if (!billedLines.length) {
      cost = { ...cost, complete: false };
      coverage = 'Unstated: live invoice lines are absent';
    }
    for (const line of billedLines) {
      const quantity = exact(line.quantity);
      if (quantity.n <= 0n) throw new Error('Invalid invoice cost quantity');
      const available = shipped.get(line.orderLine);
      const consumed = add(used.get(line.orderLine) ?? zero, quantity);
      used.set(line.orderLine, consumed);
      const amount = exact(line.amount);
      if (amount.n < 0n) throw new Error('Invalid invoice product amount');
      revenue = add(revenue, amount);
      if (
        !available ||
        available.quantity.n <= 0n ||
        add(available.quantity, neg(consumed)).n < 0n
      ) {
        coverage = 'Unstated: billed above net shipped quantity';
        cost = { ...cost, complete: false };
      } else
        cost = sumRelief(
          cost,
          scaleRelief(available, divide(quantity, available.quantity)),
        );
    }
    result.set(invoice.id, { cost, revenue, coverage });
  }
  return result;
}

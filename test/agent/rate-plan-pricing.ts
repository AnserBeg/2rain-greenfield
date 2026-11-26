/**
 * BILLING-1 s3a-i (rule 12): a drafted rate-plan structure is scored by what
 * it charges, not by its keys. The request's prices are published into the
 * drafted plan's own slots by role (a time rate by its period, a fixed fee as
 * its amount); any other slot (a cap or a minimum the model added) gets a
 * value that never binds. Then the released calculator quotes each case.
 */
import type { BillingPlan } from '../../packages/canonical-model/src/billing.js';
import { quoteBillingService } from '../../packages/domain/src/billing/quote.js';
import { compileRatePlan } from '../../packages/domain/src/billing/terms.js';

export type PricedRole =
  'hour' | 'day' | 'week' | 'fourWeek' | 'month' | 'amount';
export interface RatePlanPrices {
  /** Published values by role, mapped onto the drafted slot IDs. */
  readonly values: Readonly<Partial<Record<PricedRole, string>>>;
  /** A service of `days` whole days and `quantity` units charges `cents`. */
  readonly quotes: readonly {
    readonly days: number;
    readonly quantity?: string;
    readonly cents: string;
  }[];
}

const start = '2025-01-28T16:00:00.000Z';
const roll = (days: number) =>
  new Date(Date.parse(start) + days * 86_400_000).toISOString();

/** The cents each quote charges, or the first reason the plan cannot be
 * priced as requested. */
export function ratePlanCharges(
  plan: BillingPlan,
  prices: RatePlanPrices,
): string[] | string {
  const values: Record<string, string> = {};
  for (const slot of plan.slots)
    values[slot.id] = slot.kind === 'money' ? '1000000' : '0';
  for (const c of plan.components) {
    if (c.kind === 'time')
      for (const [period, slot] of Object.entries(c.rates)) {
        const value = prices.values[period as PricedRole];
        if (value === undefined) return `an unrequested ${period} rate`;
        values[slot] = value;
      }
    else if (c.kind === 'fixed') {
      if (prices.values.amount === undefined) return 'an unrequested fee';
      values[c.amount] = prices.values.amount;
    }
  }
  try {
    const { digest } = compileRatePlan(plan);
    return prices.quotes.map(({ days, quantity = '1' }) => {
      const quote = quoteBillingService(plan, {
        schemaVersion: 'northstar.billing-quote-evidence/v1',
        release: 'eval',
        sourceQueryId: 'eval',
        sourceRevision: '1',
        cursor: '1',
        serviceId: 'service',
        companyId: 'company',
        tenantId: 'tenant',
        environmentId: 'environment',
        customerId: 'customer',
        serviceUnit: plan.serviceUnit,
        currency: plan.currency,
        anchor: start,
        zone: 'America/Edmonton',
        asOf: roll(days),
        periodStart: start,
        serviceEnd: roll(days),
        basis: 'agreed',
        bands: [
          {
            id: 'band',
            quantity,
            intervals: [{ id: 'leg', revision: '1', start, end: roll(days) }],
          },
        ],
        pauses: [],
        usage: [],
        assignments: [],
        allocations: [],
        tables: [
          {
            schemaVersion: 'northstar.billing-rate-table/v1',
            publishedAt: '2020-01-01T00:00:00.000Z',
            version: 'eval',
            planDigest: digest,
            currency: plan.currency,
            effectiveFrom: '2020-01-01T00:00:00.000Z',
            selector: { kind: 'base' },
            values,
          },
        ],
      });
      return String(
        quote.lines.reduce((sum, l) => sum + BigInt(l.differenceCents), 0n),
      );
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Whether the plan charges exactly the request's cents for every quote. */
export function ratePlanPriced(plan: BillingPlan, prices: RatePlanPrices) {
  const charges = ratePlanCharges(plan, prices);
  return (
    Array.isArray(charges) &&
    charges.every((cents, i) => cents === prices.quotes[i]!.cents)
  );
}

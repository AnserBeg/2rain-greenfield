import { normalizeBillingPlan } from '../../../canonical-model/src/billing-normalization.js';
import { canonicalizeAndHash } from '../../../canonical-model/src/canonicalize.js';
import {
  BillingPlanSchema,
  BillingRateTableSchema,
  type BillingPlan,
  type BillingRateTable,
} from '../../../canonical-model/src/billing.js';
import { instant } from './calendar.js';
import { decimal } from './fraction.js';

export const digest = (v: unknown) => canonicalizeAndHash(v).contentHash;
export function compileRatePlan(input: unknown) {
  const p = normalizeBillingPlan(BillingPlanSchema.parse(input));
  p.slots.sort((a, b) => (a.id < b.id ? -1 : 1));
  p.components.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { plan: p, digest: digest(p) };
}
// Validate the whole immutable price version before it can be selected. A
// caller publishing new prices can append this value without editing its predecessor.
export function publishRateTable(plan: BillingPlan, input: unknown) {
  const t = BillingRateTableSchema.parse(input);
  if (t.planDigest !== digest(plan) || t.currency !== plan.currency)
    throw new Error('Rate table plan version or currency mismatch');
  if (t.effectiveEnd && instant(t.effectiveEnd) <= instant(t.effectiveFrom))
    throw new Error('Empty rate validity');
  instant(t.effectiveFrom);
  if (Object.keys(t.values).length !== plan.slots.length)
    throw new Error('Rate table requires exactly the declared slots');
  for (const slot of plan.slots) {
    const value = t.values[slot.id];
    if (value === undefined || (value.split('.')[1]?.length ?? 0) > slot.scale)
      throw new Error('Missing or unrepresentable price slot ' + slot.id);
    decimal(value);
  }
  for (const c of plan.components)
    if (
      c.kind === 'time' &&
      c.minimumMoney &&
      c.cap &&
      decimal(t.values[c.minimumMoney]!).compare(decimal(t.values[c.cap]!)) > 0
    )
      throw new Error('Billing minimum exceeds cap');
  return { table: t, digest: digest(t) };
}
export interface ListAssignment {
  listId: string;
  priority: number;
  effectiveFrom: string;
  effectiveEnd?: string | undefined;
  revision: string;
}
export function selectTable(
  tables: readonly BillingRateTable[],
  customer: string,
  assignments: readonly ListAssignment[],
  opening: number,
) {
  let best: {
    rank: number;
    priority: number;
    table: BillingRateTable;
    assignment: ListAssignment | null;
  }[] = [];
  // A successor ends only the series with the identical selector. An ended
  // successor never revives an older override.
  const assignmentHeads = new Map<string, ListAssignment[]>();
  for (const a of assignments) {
    const at = instant(a.effectiveFrom);
    if (at > opening) continue;
    const list = assignmentHeads.get(a.listId);
    if (!list || at > instant(list[0]!.effectiveFrom))
      assignmentHeads.set(a.listId, [a]);
    else if (at === instant(list[0]!.effectiveFrom)) list.push(a);
  }
  const series = new Map<string, BillingRateTable[]>();
  for (const table of tables) {
    const at = instant(table.effectiveFrom);
    if (at > opening) continue;
    const key = digest(table.selector),
      head = series.get(key);
    if (!head || at > instant(head[0]!.effectiveFrom)) series.set(key, [table]);
    else if (at === instant(head[0]!.effectiveFrom)) head.push(table);
  }
  for (const t of [...series.values()].flat()) {
    if (t.effectiveEnd && instant(t.effectiveEnd) <= opening) continue;
    const s = t.selector;
    if (s.kind === 'customer' && s.customerId !== customer) continue;
    const matches =
      s.kind === 'priceList'
        ? (assignmentHeads.get(s.listId) ?? []).filter(
            (a) => !a.effectiveEnd || opening < instant(a.effectiveEnd),
          )
        : [null];
    for (const assignment of matches) {
      const rank = s.kind === 'customer' ? 2 : s.kind === 'priceList' ? 1 : 0;
      const candidate = {
        rank,
        priority: assignment?.priority ?? 0,
        table: t,
        assignment,
      };
      const first = best[0];
      if (
        !first ||
        rank > first.rank ||
        (rank === first.rank && candidate.priority > first.priority)
      )
        best = [candidate];
      else if (rank === first.rank && candidate.priority === first.priority)
        best.push(candidate);
    }
  }
  if (best.length !== 1)
    throw new Error(
      best.length
        ? 'Ambiguous rate table selection'
        : 'Missing effective rate table',
    );
  return best[0]!;
}

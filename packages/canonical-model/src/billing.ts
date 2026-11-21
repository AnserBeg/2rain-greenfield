import { z } from 'zod';

export const BILLING_CALCULATION_VERSION = 'northstar.billing-calculation/v2';
export const BILLING_READER = 30;
export const BILLING_INTERVAL_READER = 36;
export const BILLING_QUOTE_CAPABILITY = 'northstar.billing:capability.quote';
export const BILLING_TERMS_CAPABILITY = 'northstar.billing:capability.terms';
export const billingPeriods = [
  'hour',
  'day',
  'week',
  'fourWeek',
  'month',
] as const;
export type BillingPeriod = (typeof billingPeriods)[number];
const id = z.string().min(1).max(160);
const currency = z.enum(['CAD', 'USD', 'EUR']);
const period = z.enum(billingPeriods);
const civilPeriod = z.enum(['day', 'week', 'fourWeek', 'month']);
const proration = z.enum(['activeCoverage', 'none']);
const periodSlots = z.partialRecord(period, id);
const common = { id, taxClassification: id };
const cadence = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('anniversary'),
    months: z.int().min(1).max(120),
  }),
  z.strictObject({
    kind: z.literal('fixedDays'),
    days: z.int().min(1).max(3660),
  }),
  z.strictObject({
    kind: z.literal('calendarMonth'),
    boundaryMinutes: z.int().min(0).max(1439),
  }),
]);
const schedule = z.union([
  cadence,
  z.strictObject({ kind: z.literal('onServiceEnd') }),
]);
const component = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('time'),
    base: z.literal('serviceInterval'),
    stage: z.literal('beforeMinimum'),
    rates: periodSlots,
    minimumMoney: id.optional(),
    minimumDuration: z
      .strictObject({ period, count: z.int().min(1).max(744) })
      .optional(),
    minimumScope: z.enum(['perEnrollment', 'perPricingWindow']).optional(),
    cap: id.optional(),
    partialTime: z.enum(['wholeStarted', 'prorateShortestTail']).optional(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('fixed'),
    base: z.literal('enrollment'),
    stage: z.literal('afterCapBeforeTax'),
    amount: id,
    occurrence: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('oneOff'),
        at: z.enum(['serviceStart', 'serviceEnd']),
      }),
      z.strictObject({
        kind: z.literal('recurring'),
        cadence,
        fixedFeeDuringPause: z.enum(['suspend', 'continue']).optional(),
        feeProration: proration.optional(),
      }),
    ]),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('meter'),
    stage: z.literal('afterCapBeforeTax'),
    streamId: id,
    unit: id,
    overageRate: id,
    allowanceProration: proration.optional(),
    allowanceBasis: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('perCycle'), quantity: id }),
      z.strictObject({ kind: z.literal('perPricingWindow'), quantity: id }),
      z.strictObject({
        kind: z.literal('perBilledPeriod'),
        timeComponent: id,
        quantities: periodSlots,
      }),
    ]),
  }),
]);
export const BillingPlanSchema = z
  .strictObject({
    schemaVersion: z.literal('v6'),
    id,
    version: id,
    currency,
    serviceUnit: id,
    schedule,
    pricingWindow: civilPeriod.optional(),
    bindings: z
      .strictObject({
        quoteQueryId: id,
        evidenceQueryId: id,
        // Historical declarations parse so the compiler can explain their refusal.
        evidenceFieldId: id.optional(),
        agreedInterval: z
          .strictObject({
            customerFieldId: id,
            currencyFieldId: id,
            startFieldId: id,
            endFieldId: id,
            zone: z.string().min(1).max(100),
          })
          .optional(),
        publishOperationId: id,
        overrideOperationId: id,
        assignmentOperationId: id,
        termsQueryId: id,
        termsFieldId: id,
      })
      .optional(),
    slots: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            id,
            kind: z.literal('money'),
            currency,
            scale: z.int().min(0).max(9),
          }),
          z.strictObject({
            id,
            kind: z.literal('quantity'),
            unit: id,
            scale: z.int().min(0).max(9),
          }),
        ]),
      )
      .min(1)
      .max(256),
    components: z.array(component).min(1).max(32),
  })
  .superRefine((plan, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    const slots = new Map(plan.slots.map((s) => [s.id, s]));
    const used = new Set<string>();
    if (
      slots.size !== plan.slots.length ||
      new Set(plan.components.map((c) => c.id)).size !== plan.components.length
    )
      issue('Duplicate billing ID');
    for (const slot of slots.values())
      if (slot.kind === 'money' && slot.currency !== plan.currency)
        issue('Mixed billing currencies');
    function check(key: string, unit?: string) {
      const slot = slots.get(key);
      if (
        !slot ||
        (unit === undefined
          ? slot.kind !== 'money'
          : slot.kind !== 'quantity' || slot.unit !== unit)
      )
        issue('Incompatible billing slot ' + key);
      used.add(key);
    }
    for (const c of plan.components) {
      if (c.kind === 'time') {
        if (!Object.keys(c.rates).length) issue('Missing time offer');
        for (const ref of Object.values(c.rates)) check(ref);
        if (c.minimumMoney) check(c.minimumMoney);
        if (c.cap) check(c.cap);
      } else if (c.kind === 'fixed') check(c.amount);
      else {
        check(c.overageRate);
        const basis = c.allowanceBasis;
        if (basis.kind === 'perBilledPeriod') {
          const time = plan.components.find(
            (t) => t.id === basis.timeComponent,
          );
          if (
            time?.kind !== 'time' ||
            Object.keys(time.rates).sort().join() !==
              Object.keys(basis.quantities).sort().join()
          )
            issue('Allowance must name every offer of one time component');
          for (const ref of Object.values(basis.quantities)) check(ref, c.unit);
        } else check(basis.quantity, c.unit);
      }
    }
    if (used.size !== slots.size) issue('Unused or unknown billing slots');
  });
export const BillingPlansSchema = z
  .array(BillingPlanSchema)
  .min(1)
  .max(32)
  .superRefine((plans, ctx) => {
    if (
      new Set(plans.map((p) => JSON.stringify([p.id, p.version]))).size !==
      plans.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate rate plan version' });
  });
export type AuthoredBillingPlan = z.infer<typeof BillingPlanSchema>;
export type { BillingPlan, TimeComponent } from './billing-normalization.js';
export type BillingSchedule = z.infer<typeof schedule>;
export const BillingRateTableSchema = z.strictObject({
  schemaVersion: z.literal('northstar.billing-rate-table/v1'),
  version: id,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  currency,
  effectiveFrom: z.iso.datetime(),
  effectiveEnd: z.iso.datetime().optional(),
  selector: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('base') }),
    z.strictObject({ kind: z.literal('customer'), customerId: id }),
    z.strictObject({ kind: z.literal('priceList'), listId: id }),
  ]),
  values: z.record(id, z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,9})?$/u)),
});
export type BillingRateTable = z.infer<typeof BillingRateTableSchema>;

export const BillingListAssignmentSchema = z
  .strictObject({
    schemaVersion: z.literal('northstar.billing-list-assignment/v1'),
    customerId: id,
    listId: id,
    revision: id,
    priority: z.int(),
    effectiveFrom: z.iso.datetime({ precision: 3 }),
    effectiveEnd: z.iso.datetime({ precision: 3 }).optional(),
  })
  .refine(
    (a) => !a.effectiveEnd || a.effectiveEnd > a.effectiveFrom,
    'Invalid list assignment interval',
  );

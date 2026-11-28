import { z } from 'zod';
import { SERVICE_USE_PROTOCOL } from './service-evidence.js';
import { canonicalize } from './canonicalize.js';

export const BILLING_CALCULATION_VERSION = 'northstar.billing-calculation/v2';
export const BILLING_READER = 30;
export const BILLING_INTERVAL_READER = 36;
export const BILLING_ALLOCATION_READER = 41;
export const BILLING_ARREARS_READER = 45;
export const BILLING_CYCLE_CALCULATION = 'northstar.billing-calculation/v3';
/** Rate rules (combination, per-rate partials, a cap as a multiple of a
 * rate, per-quantity fees, record quantities, early return) and the
 * service-use evidence source. A plan that declares none of them keeps v2/v3
 * and its earlier reader. Provisional: renumbered at merge. */
export const BILLING_RULES_READER = 54;
export const BILLING_RULES_CALCULATION = 'northstar.billing-calculation/v4';
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
    // A money slot, or a whole multiple of an offered rate ("2 x weekly").
    cap: z
      .union([
        id,
        z.strictObject({ rate: period, times: z.int().min(1).max(1000) }),
      ])
      .optional(),
    partialTime: z.enum(['wholeStarted', 'prorateShortestTail']).optional(),
    // How offered rates combine to cover a pricing window's active time.
    // Absent is bestPrice, the least exact price of any cover (calculation
    // v2/v3 behaviour). ladder fills whole blocks from the longest rate down;
    // capAtNextTier never lets the shorter rates exceed one more block of the
    // rate above. prorate charges the longest rate one whole block of which
    // fits, pro rata for the whole active time.
    combination: z
      .discriminatedUnion('rule', [
        z.strictObject({ rule: z.literal('bestPrice') }),
        z.strictObject({
          rule: z.literal('ladder'),
          capAtNextTier: z.boolean(),
        }),
        z.strictObject({ rule: z.literal('prorate') }),
      ])
      .optional(),
    // Per offered rate: is a final, partly used block charged whole or pro
    // rata? Absent rates are whole under bestPrice and ladder, and pro rata
    // under prorate.
    partial: z.partialRecord(period, z.enum(['whole', 'prorate'])).optional(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('fixed'),
    base: z.literal('enrollment'),
    stage: z.literal('afterCapBeforeTax'),
    amount: id,
    // The amount is per unit of the service's one commercial quantity.
    perQuantity: z.literal(true).optional(),
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
            // A required number on the billed record: its commercial quantity.
            quantityFieldId: id.optional(),
            zone: z.string().min(1).max(100),
          })
          .optional(),
        arrearsSource: z
          .discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('agreedInterval') }),
            z.strictObject({
              kind: z.literal('periodMeter'),
              streamId: id,
              unit: id,
              openingReadingFieldId: id,
              closingReadingFieldId: id,
              openingInstantFieldId: id,
              closingInstantFieldId: id,
            }),
            // Persisted at reader 45 before the protocol existed. Read through
            // the replay rule below, never rewritten: rate tables are keyed
            // by the plan digest.
            z.strictObject({
              kind: z.literal('bookingActuals'),
              queryId: id,
              slotId: id,
            }),
            z.strictObject({
              kind: z.literal('evidenceQuery'),
              queryId: id,
              protocol: z.literal(SERVICE_USE_PROTOCOL),
              subjectId: id,
              // Absent keeps calculation v3: the agreed end still closes the
              // service and only use inside it is rated. agreedEnd keeps the
              // service open to the agreed end; actualEnd ends it at the last
              // return. A minimum term in periods from service start holds
              // the service end at least that late. Committed time runs from
              // the LAST RETURN to the service end: time before the first
              // pickup and gaps between legs are not committed.
              earlyReturn: z
                .strictObject({
                  bill: z.enum(['agreedEnd', 'actualEnd']),
                  minimumTerm: z
                    .strictObject({ period, count: z.int().min(1).max(744) })
                    .optional(),
                })
                .optional(),
            }),
          ])
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
        if (typeof c.cap === 'string') check(c.cap);
        else if (c.cap && !c.rates[c.cap.rate])
          issue('A cap multiple must name an offered rate');
        if (Object.keys(c.partial ?? {}).some((p) => !(p in c.rates)))
          issue('A partial rule must name an offered rate');
        // A ladder charges a partial block only in its shortest offered rate;
        // a partial rule on a longer rate would be declared and never read.
        const shortest = billingPeriods.find((p) => p in c.rates);
        if (
          c.combination?.rule === 'ladder' &&
          Object.keys(c.partial ?? {}).some((p) => p !== shortest)
        )
          issue('Under ladder a partial rule names only the shortest rate');
        if (
          c.partialTime === 'prorateShortestTail' &&
          (c.combination || c.partial)
        )
          issue('partialTime is replaced by partial under a combination');
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

type ArrearsSource = NonNullable<
  NonNullable<AuthoredBillingPlan['bindings']>['arrearsSource']
>;
export type BillingEvidenceQuery = Extract<
  ArrearsSource,
  { kind: 'evidenceQuery' }
>;

/** The service-use evidence source a plan reads, if any. Replay rule: the
 * provider-named declaration persisted at reader 45 reads as the service-use
 * protocol with its slot as the subject, so its bytes, digest, reader and
 * calculation stay what they were. */
export function billingEvidenceQuery(
  source: ArrearsSource | undefined,
): BillingEvidenceQuery | undefined {
  if (
    !source ||
    source.kind === 'agreedInterval' ||
    source.kind === 'periodMeter'
  )
    return undefined;
  if (source.kind === 'evidenceQuery') return source;
  return {
    kind: 'evidenceQuery',
    queryId: source.queryId,
    protocol: SERVICE_USE_PROTOCOL,
    subjectId: source.slotId,
  };
}

/** Whether a plan declares anything that needs calculation v4 and the rules
 * reader. Absent keys keep every earlier plan's bytes and floor. It reads the
 * stored JSON shape, so the release loader can ask it before parsing. */
export function hasBillingRules(plan: unknown): boolean {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!record(plan)) return false;
  const bindings = record(plan.bindings) ? plan.bindings : {};
  const source = record(bindings.arrearsSource) ? bindings.arrearsSource : {};
  const interval = record(bindings.agreedInterval)
    ? bindings.agreedInterval
    : {};
  const components = Array.isArray(plan.components) ? plan.components : [];
  return (
    source.kind === 'evidenceQuery' ||
    interval.quantityFieldId !== undefined ||
    components.some(
      (c) =>
        record(c) &&
        (c.combination !== undefined ||
          c.partial !== undefined ||
          record(c.cap) ||
          c.perQuantity !== undefined),
    )
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The calculation version and reader floor a set of stored plans requires.
 * `calculation` is undefined when no plan binds an agreed interval. */
export function billingReleaseTerms(plans: unknown) {
  const list = Array.isArray(plans) ? plans : [];
  const bound = (key: string) =>
    list.some((p) => isRecord(p) && isRecord(p.bindings) && p.bindings[key]);
  const agreed = bound('agreedInterval');
  const arrears = bound('arrearsSource');
  const rules = list.some(hasBillingRules);
  return {
    agreed,
    calculation: !agreed
      ? undefined
      : rules
        ? BILLING_RULES_CALCULATION
        : arrears
          ? BILLING_CYCLE_CALCULATION
          : BILLING_CALCULATION_VERSION,
    floor: rules
      ? BILLING_RULES_READER
      : arrears
        ? BILLING_ARREARS_READER
        : agreed
          ? BILLING_ALLOCATION_READER
          : BILLING_READER,
  };
}

/** The release loader's admission of billing (BILLING_PLAN_MISMATCH): the
 * surface carries exactly the declared plans, the calculation version they
 * need, and a reader floor at least theirs; a release without plans never
 * claims a billing reader. A surface floor below the allocation reader with
 * no calculation version is the interval reader. */
export function billingReleaseMismatch(
  declared: unknown,
  payload: Record<string, unknown>,
  surfaceFloor: number,
): boolean {
  const terms = billingReleaseTerms(declared);
  const hasCalculation = Object.hasOwn(payload, 'billingCalculationVersion');
  const floor =
    terms.floor === BILLING_ALLOCATION_READER && !hasCalculation
      ? BILLING_INTERVAL_READER
      : terms.floor;
  return (
    canonicalize(payload.billingPlans ?? null) !==
      canonicalize(declared ?? null) ||
    (hasCalculation &&
      (!terms.agreed ||
        payload.billingCalculationVersion !== terms.calculation)) ||
    (terms.agreed &&
      surfaceFloor >= BILLING_ALLOCATION_READER &&
      !hasCalculation) ||
    (Boolean(declared) && surfaceFloor < floor) ||
    (!declared &&
      [
        BILLING_READER,
        BILLING_INTERVAL_READER,
        BILLING_ALLOCATION_READER,
        BILLING_ARREARS_READER,
        BILLING_RULES_READER,
      ].includes(surfaceFloor))
  );
}

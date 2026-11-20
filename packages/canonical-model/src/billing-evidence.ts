import { z } from 'zod';
import { BillingRateTableSchema } from './billing.js';
const id = z.string().min(1).max(160);
const time = z.iso.datetime({ precision: 3 });
const value = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,9})?$/u);
// A 128-digit fraction numerator can produce at most 130 digits in cents.
const cents = z.string().regex(/^(0|[1-9]\d{0,129})$/u);
const revision = { id, revision: id };
const interval = z.strictObject({
  ...revision,
  start: time,
  end: time.nullable(),
});
export const BillingQuoteEvidenceSchema = z.strictObject({
  schemaVersion: z.literal('northstar.billing-quote-evidence/v1'),
  release: id,
  sourceQueryId: id,
  sourceRevision: id,
  cursor: id,
  serviceId: id,
  companyId: id,
  tenantId: id,
  environmentId: id,
  customerId: id,
  serviceUnit: id,
  currency: z.enum(['CAD', 'USD', 'EUR']),
  anchor: time,
  zone: z.string().min(1).max(100),
  asOf: time,
  serviceEnd: time.nullable(),
  periodStart: time,
  basis: z.enum(['actual', 'agreed', 'usageOnly']),
  // Each band follows the same commercial quantity through swaps and returns.
  bands: z
    .array(
      z.strictObject({
        id,
        quantity: value,
        intervals: z.array(interval).max(256),
      }),
    )
    .max(32),
  pauses: z.array(interval.extend({ bandId: id.optional() })).max(256),
  usage: z
    .array(
      z.strictObject({
        ...revision,
        streamId: id,
        unit: id,
        at: time,
        quantity: value,
        bandId: id.optional(),
      }),
    )
    .max(2048),
  assignments: z
    .array(
      z.strictObject({
        publishedAt: time,
        listId: id,
        priority: z.int(),
        effectiveFrom: time,
        effectiveEnd: time.optional(),
        revision: id,
      }),
    )
    .max(128),
  tables: z
    .array(BillingRateTableSchema.extend({ publishedAt: time }))
    .min(1)
    .max(256),
  allocations: z
    .array(
      z.strictObject({
        componentId: id,
        occurrence: id.max(512),
        allocatedCents: cents,
        reservedCents: cents,
      }),
    )
    .max(4096),
});
export type BillingQuoteEvidence = z.infer<typeof BillingQuoteEvidenceSchema>;

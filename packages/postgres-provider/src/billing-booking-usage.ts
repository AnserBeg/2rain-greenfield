import { bookingOwnerCursorFence } from './booking-owner-usage.js';
import { z } from 'zod';
import type { BillingQuoteEvidence } from '../../canonical-model/src/billing-evidence.js';
import { decimal } from '../../domain/src/billing/fraction.js';

// Booking SQL emits offsets and up to six fractional digits. Effective
// boundaries must be exactly representable by the millisecond calculator.
const effectiveInstant = z.iso
  .datetime({ offset: true })
  .refine(
    (s) => !/\.\d{3}\d*[1-9]\d*(?:Z|[+-])/u.test(s),
    'Booking time exceeds the Billing precision',
  )
  .transform((s) => new Date(s).toISOString());
const ownerUsage = z.object({
  schemaVersion: z.literal('booking.ownerUsage/v1'),
  ownerRef: z.object({ entityId: z.string(), recordId: z.string() }),
  ownerScope: z.object({ kind: z.literal('company'), companyId: z.string() }),
  asOf: z.iso.datetime({ offset: true }),
  cursor: z.string().regex(/^(0|[1-9]\d*)$/u),
  highWater: z.string(),
  hasMore: z.literal(false),
  changes: z.array(z.never()),
  bookings: z.array(
    z.object({
      bookingId: z.string(),
      slotId: z.string(),
      fulfilmentMode: z.string(),
      unit: z.string(),
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      bookingId: z.string(),
      revision: z.int().positive(),
      kind: z.enum(['use', 'pause', 'assignment', 'attendance']),
      voided: z.boolean(),
      effectiveStart: z.string(),
      effectiveEnd: z.string().nullable(),
      quantity: z.string().nullable(),
      unit: z.string().nullable(),
    }),
  ),
});

export function billingBookingUsage(
  value: unknown,
  owner: { entityId: string; recordId: string; companyId: string },
  slotId: string,
  unit: string,
  cycleEnd: string,
) {
  const snapshot = ownerUsage.parse(value);
  if (
    snapshot.ownerRef.entityId !== owner.entityId ||
    snapshot.ownerRef.recordId !== owner.recordId ||
    snapshot.ownerScope.companyId !== owner.companyId
  )
    throw new Error('Billing booking owner or company disagrees');
  if (
    snapshot.cursor !== snapshot.highWater ||
    Date.parse(snapshot.asOf) < Date.parse(cycleEnd)
  )
    throw new Error('Incomplete booking usage snapshot');
  const bookings = snapshot.bookings.filter((b) => b.slotId === slotId);
  if (
    bookings.length !== 1 ||
    bookings[0]!.fulfilmentMode !== 'tracked' ||
    bookings[0]!.unit !== unit
  )
    throw new Error(
      'Billing requires one identifiable tracked booking in its slot',
    );
  const bandId = bookings[0]!.bookingId;
  const rows = snapshot.evidence.filter(
    (r) => r.bookingId === bandId && !r.voided,
  );
  const legs = rows.filter((r) => r.kind === 'use');
  const bandQuantity = legs[0]?.quantity;
  if (
    !bandQuantity ||
    legs.some(
      (r) =>
        r.unit !== unit ||
        !r.quantity ||
        decimal(r.quantity).compare(decimal(bandQuantity)) !== 0,
    )
  )
    throw new Error(
      'Billing requires actual use with an unambiguous commercial quantity',
    );
  const interval = (r: (typeof rows)[number]) => ({
    id: r.id,
    revision: String(r.revision),
    start: effectiveInstant.parse(r.effectiveStart),
    end:
      r.effectiveEnd === null ? null : effectiveInstant.parse(r.effectiveEnd),
  });
  return {
    basis: 'actual',
    cursor: snapshot.cursor,
    bands: [
      { id: bandId, quantity: bandQuantity, intervals: legs.map(interval) },
    ],
    pauses: rows
      .filter((r) => r.kind === 'pause')
      .map((r) => ({ ...interval(r), bandId })),
  } satisfies Pick<
    BillingQuoteEvidence,
    'basis' | 'cursor' | 'bands' | 'pauses'
  >;
}

export async function fenceBillingBookingOwners(
  client: import('pg').PoolClient,
  releaseId: string,
  fence: number,
  owners: readonly {
    queryId: string;
    entityId: string;
    recordId: string;
    cursor: string;
  }[],
) {
  // A consolidated writer must take all endpoint record locks first. Booking
  // locks the whole set of cursors in its canonical order in this single call.
  const current = await bookingOwnerCursorFence(
    client,
    releaseId,
    fence,
    owners.map(({ queryId, recordId }) => ({ queryId, recordId })),
  );
  const key = (entity: string, id: string) => JSON.stringify([entity, id]);
  const expected = new Map(
    owners.map((o) => [key(o.entityId, o.recordId), o.cursor]),
  );
  if (
    current.schemaVersion !== 'booking.ownerCursorFence/v1' ||
    current.owners.length !== expected.size ||
    current.owners.some((row) => {
      const id = key(row.ownerRef.entityId, row.ownerRef.recordId);
      return expected.get(id) !== row.cursor || !expected.delete(id);
    })
  )
    throw new Error('Stale billing booking cursor');
}

import type { BillingQuoteEvidence } from '../../../canonical-model/src/billing-evidence.js';
import type { ServiceUseSnapshot } from '../../../canonical-model/src/service-evidence.js';
import { decimal } from './fraction.js';

export interface ServiceUseInput {
  readonly snapshot: ServiceUseSnapshot;
  readonly subjectId: string;
  readonly owner: {
    readonly entityId: string;
    readonly recordId: string;
    readonly companyId: string;
  };
}

/** Actual use sets the service end (ADR-0083, calculation v3). A live use
 * leg keeps the service open, so cycles continue through the review instant.
 * Once every leg is returned the service ends at the later of the agreed end
 * and the last recorded return; an early return keeps the agreed end. Without
 * exactly one engagement with use in the subject the agreed end stands, and
 * the coverage below refuses any review that falls due. */
export function serviceUseEnd(
  snapshot: ServiceUseSnapshot,
  subjectId: string,
  agreedEnd: string | null,
) {
  const engagements = snapshot.engagements.filter(
    (e) => e.subjectId === subjectId,
  );
  if (engagements.length !== 1) return agreedEnd;
  const legs = engagements[0]!.legs;
  if (!legs.length) return agreedEnd;
  let returned = Number.NEGATIVE_INFINITY;
  for (const leg of legs) {
    if (leg.end === null) return null;
    returned = Math.max(returned, Date.parse(leg.end));
  }
  return new Date(
    agreedEnd === null ? returned : Math.max(returned, Date.parse(agreedEnd)),
  ).toISOString();
}

/** The actual coverage of one engagement through a closed cycle: one band
 * with one commercial quantity, its use legs and its pauses. */
export function serviceUseCoverage(
  { snapshot, subjectId, owner }: ServiceUseInput,
  unit: string,
  cycleEnd: string,
) {
  if (
    snapshot.owner.entityId !== owner.entityId ||
    snapshot.owner.recordId !== owner.recordId ||
    snapshot.owner.companyId !== owner.companyId
  )
    throw new Error('Billing service-use owner or company disagrees');
  if (!snapshot.complete || Date.parse(snapshot.asOf) < Date.parse(cycleEnd))
    throw new Error('Incomplete service-use snapshot');
  const engagements = snapshot.engagements.filter(
    (e) => e.subjectId === subjectId,
  );
  const engagement = engagements[0];
  if (
    engagements.length !== 1 ||
    engagement!.mode !== 'actual' ||
    engagement!.unit !== unit
  )
    throw new Error(
      'Billing requires one identifiable actual engagement in its subject',
    );
  const { id: bandId, legs, pauses } = engagement!;
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
  const interval = (r: (typeof pauses)[number]) => ({
    id: r.id,
    revision: r.revision,
    start: r.start,
    end: r.end,
  });
  return {
    basis: 'actual',
    cursor: snapshot.cursor,
    bands: [
      { id: bandId, quantity: bandQuantity, intervals: legs.map(interval) },
    ],
    pauses: pauses.map((r) => ({ ...interval(r), bandId })),
  } satisfies Pick<
    BillingQuoteEvidence,
    'basis' | 'cursor' | 'bands' | 'pauses'
  >;
}

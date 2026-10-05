import { createHash } from 'node:crypto';
import { purchaseOrderRevisionImage } from '../../domain/src/purchasing/approvals.js';

/** Shared by the request executor and its governed read model. */
export function purchaseOrderRevisionDigest(
  revision: number,
  lines: readonly { recordId: string; revision: number }[],
): string {
  return createHash('sha256')
    .update(purchaseOrderRevisionImage(revision, lines))
    .digest('hex');
}

/** A reviewed amendment binds its entire immutable proposal image by revision. */
export function purchaseOrderAmendmentRevisionDigest(
  orderDigest: string,
  proposal: { readonly recordId: string; readonly revision: number },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'purchase-order-amendment/v1',
        orderDigest,
        proposal.recordId,
        proposal.revision,
      ]),
    )
    .digest('hex');
}

export function currentPurchaseOrderApproval(
  digest: string,
  requests: readonly { digest: string; state: string; kind: string }[],
): 'Approved' | 'Pending' | 'Rejected' | 'Not requested' {
  const current = requests.filter(
    (request) => request.digest === digest && request.kind === 'order',
  );
  if (current.some((request) => request.state === 'approved'))
    return 'Approved';
  if (current.some((request) => request.state === 'pending')) return 'Pending';
  if (current.some((request) => request.state === 'rejected'))
    return 'Rejected';
  return 'Not requested';
}

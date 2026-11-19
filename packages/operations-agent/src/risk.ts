/** Only a revision-checked O0 patch can run before confirmation. */
import type { RegisteredOperationDefinition } from '../../runtime/src/semantic-operation-gateway.js';

import { effectKind, type PinnedCatalog } from './catalog.js';

export type RiskClass = 'reversible' | 'needsYes';

export interface OperationRisk {
  readonly riskClass: RiskClass;
  /**
   * Why, as one plain sentence the person reads on the plan card (X16); the
   * approvals record keeps it too.
   */
  readonly reason: string;
  /** The inverse for a reversible operation. */
  readonly inverse?: {
    readonly kind: 'restorePriorValues';
    readonly operationId: string;
  };
}

// Field identities are scoped to the reviewed first-party record and update.
// A newly compiled patch contract alone supplies no evidence for auto-approval.
const reversibleUpdates = new Map(
  Object.entries({
    item: ['description', 'name'],
    legal_entity: ['name'],
    location: ['name'],
    party: ['contact_summary', 'credit_hold', 'name', 'payment_terms'],
    purchase_order: ['notes'],
    sales_order: ['notes'],
    stock_count_line: ['counted_quantity'],
    tax_code: ['name'],
  }).map(([entity, fields]) => [
    `northstar.app:operation.${entity}_update`,
    {
      entity: `northstar.app:entity.${entity}`,
      fields: new Set(
        fields.map((field) => `northstar.app:field.${entity}_${field}`),
      ),
    },
  ]),
);

export function operationRisk(
  catalog: PinnedCatalog,
  operation: RegisteredOperationDefinition,
  writtenFieldIds: readonly string[] = [],
): OperationRisk {
  const kind = effectKind(operation);
  const tier = (operation as { tier?: unknown }).tier;
  if (tier !== 'o0' && tier !== 'o1')
    return {
      riskClass: 'needsYes',
      reason: 'The assistant cannot tell what this does, so it needs your OK.',
    };
  if (tier === 'o1')
    return {
      riskClass: 'needsYes',
      reason:
        "This moves stock or money, or settles a document's status for good, so it needs your OK.",
    };
  if (operation.confirmation !== 'none')
    return {
      riskClass: 'needsYes',
      reason: 'This change needs your OK.',
    };
  if (kind === 'createRecordEffect')
    return { riskClass: 'needsYes', reason: 'Adding a record needs your OK.' };
  if (kind === 'updateRecordEffect') {
    const keys = operation.inputContract?.closedArgumentKeys ?? [];
    const entity = catalog.operationEntity(operation);
    if (
      catalog.confirmationRequiredFor.has(entity) ||
      writtenFieldIds.some((id) => catalog.confirmationRequiredFor.has(id))
    )
      return {
        riskClass: 'needsYes',
        reason: 'This changes a setting, so it needs your OK.',
      };
    // A field another operation of the record type writes only with the
    // person's confirmation (a period's reopen) is guarded: changing it, or
    // putting it back, needs that confirmation too.
    const fields = new Set(operation.inputContract?.writableFieldIds ?? []);
    const guarded = catalog.operations.some(
      (candidate) =>
        candidate !== operation &&
        candidate.confirmation !== 'none' &&
        catalog.operationEntity(candidate) === entity &&
        (candidate.inputContract?.writableFieldIds ?? []).some((field) =>
          fields.has(field),
        ),
    );
    if (guarded)
      return {
        riskClass: 'needsYes',
        reason: 'This changes something that always needs your OK.',
      };
    const reviewed = reversibleUpdates.get(operation.operationId);
    return keys.includes('patch') &&
      keys.includes('expectedRevision') &&
      operation.infrastructure?.optimisticRevision === 'compareAndIncrement' &&
      reviewed?.entity === entity &&
      writtenFieldIds.length > 0 &&
      writtenFieldIds.every(
        (field) => reviewed.fields.has(field) && fields.has(field),
      )
      ? {
          riskClass: 'reversible',
          reason: 'Undo puts the old values back.',
          inverse: {
            kind: 'restorePriorValues',
            operationId: operation.operationId,
          },
        }
      : {
          riskClass: 'needsYes',
          reason:
            'The assistant cannot verify Undo for this change, so it needs your OK.',
        };
  }
  return {
    riskClass: 'needsYes',
    reason:
      kind === 'archiveRecordEffect'
        ? 'Archiving needs your OK.'
        : kind === 'restoreRecordEffect'
          ? 'Bringing back an archived record needs your OK.'
          : kind === 'transitionStateEffect'
            ? "Changing a document's status needs your OK."
            : 'This change cannot be undone, so it needs your OK.',
  };
}

/**
 * The assistant's autonomy policy: act at once only where the release proves
 * Undo. It reads the release's reversibility declaration (AI-UNDO-1) and holds
 * no id, namespace or name: an operation or field the release does not
 * declare is the worst case, and asks.
 */
import type { RegisteredOperationDefinition } from '../../runtime/src/semantic-operation-gateway.js';
import type {
  OperationReversibility,
  ReversibilityClass,
} from '../../canonical-model/src/reversibility.js';

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
  /**
   * For a reversible update: the lifecycle states its record (and each
   * declared parent) must be in for Undo to hold. The session checks them
   * against the record it read.
   */
  readonly holdsWhile?: OperationReversibility['holdsWhile'];
}

const CANNOT_VERIFY =
  'The assistant cannot verify Undo for this change, so it needs your OK.';

/** The plain reason a field's declared class asks, or null when it may act. */
function fieldReason(declared: ReversibilityClass | undefined): string | null {
  if (!declared) return CANNOT_VERIFY;
  if (declared.basis === 'declared')
    return 'This changes a setting, so it needs your OK.';
  if (declared.because.includes('confirmedWriter'))
    return 'This changes something that always needs your OK.';
  if (declared.because.includes('readAsGate'))
    return 'Other actions depend on this value, so changing it needs your OK.';
  if (declared.undo !== 'exact' || declared.reach !== 'record')
    return CANNOT_VERIFY;
  return null;
}

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
    const declared = catalog.reversibility.get(operation.operationId);
    const fields = new Map(
      (declared?.fields ?? []).map((field) => [field.fieldId, field]),
    );
    if (writtenFieldIds.length === 0 || !declared)
      return { riskClass: 'needsYes', reason: CANNOT_VERIFY };
    for (const field of writtenFieldIds) {
      const reason = fieldReason(fields.get(field));
      if (reason) return { riskClass: 'needsYes', reason };
    }
    // The declaration is the release's claim; the pinned contract must still
    // be the revision-checked patch the claim was derived from.
    const keys = operation.inputContract?.closedArgumentKeys ?? [];
    const writable = new Set(operation.inputContract?.writableFieldIds ?? []);
    return declared.undo === 'exact' &&
      declared.inverse === 'restorePriorValues' &&
      keys.includes('patch') &&
      keys.includes('expectedRevision') &&
      operation.infrastructure?.optimisticRevision === 'compareAndIncrement' &&
      writtenFieldIds.every((field) => writable.has(field))
      ? {
          riskClass: 'reversible',
          reason: 'Undo puts the old values back.',
          inverse: {
            kind: 'restorePriorValues',
            operationId: operation.operationId,
          },
          ...(declared.holdsWhile ? { holdsWhile: declared.holdsWhile } : {}),
        }
      : { riskClass: 'needsYes', reason: CANNOT_VERIFY };
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

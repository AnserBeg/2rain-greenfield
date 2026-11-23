/**
 * Only a revision-checked O0 patch can run before confirmation, and only for
 * fields that have a value inverse and no consumer the release cannot see
 * (AI-UNDO-1, owner ruling 2026-11-22). The policy names no record type or
 * field:
 * - a record type a capability owns acts at once only on the fields that
 *   capability declares at product assembly (its code is a consumer the
 *   release cannot see), less any the release's own consumers read;
 * - a record type no capability owns acts at once only on the fields the
 *   release's compiled reversibility declaration classes `exact`, inverse
 *   `restorePriorValues`, reach `record` (no gate, no consumer, no guarded
 *   writer, no declared confirmation);
 * - a field nobody declares, or a release without the declaration, asks.
 */
import type { RegisteredOperationDefinition } from '../../runtime/src/semantic-operation-gateway.js';
import type {
  HoldsWhile,
  ImmediateEditDeclaration,
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
   * For a reversible update: the lifecycle states the record (or a parent)
   * must be in for Undo to hold, from the owner's declaration. The session
   * checks them against what it read.
   */
  readonly holdsWhile?: readonly HoldsWhile[];
}

export function operationRisk(
  catalog: PinnedCatalog,
  operation: RegisteredOperationDefinition,
  writtenFieldIds: readonly string[],
  immediateEdits: readonly ImmediateEditDeclaration[],
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
    // The owner of the record type decides which of its fields may change at
    // once. A type no capability owns follows the release's own compiled
    // declaration, which never loosens an owned type.
    const owner = immediateEdits.find((declaration) =>
      declaration.ownedEntityIds.includes(entity),
    );
    const compiled = catalog.reversibility.get(operation.operationId);
    const compiledFields = new Map(
      (compiled?.fields ?? []).map((field) => [field.fieldId, field]),
    );
    const declared = new Map<string, { readonly holdsWhile?: HoldsWhile }>(
      owner
        ? // A consumer the release declares (a tenant workflow, rule or
          // billing plan reading the field) still makes an owned field ask.
          owner.immediateFields.flatMap((field) =>
            compiledFields
              .get(field.fieldId)
              ?.because.includes('readByConsumer')
              ? []
              : [[field.fieldId, field] as const],
          )
        : writtenFieldIds.flatMap((fieldId) => {
            const field = compiledFields.get(fieldId);
            return field &&
              field.undo === 'exact' &&
              field.inverse === 'restorePriorValues' &&
              field.reach === 'record'
              ? [
                  [
                    fieldId,
                    compiled?.holdsWhile
                      ? { holdsWhile: compiled.holdsWhile }
                      : {},
                  ],
                ]
              : [];
          }),
    );
    const holdsWhile = writtenFieldIds.flatMap((field) => {
      const condition = declared.get(field)?.holdsWhile;
      return condition ? [condition] : [];
    });
    return keys.includes('patch') &&
      keys.includes('expectedRevision') &&
      operation.infrastructure?.optimisticRevision === 'compareAndIncrement' &&
      writtenFieldIds.length > 0 &&
      writtenFieldIds.every((field) => declared.has(field) && fields.has(field))
      ? {
          riskClass: 'reversible',
          reason: 'Undo puts the old values back.',
          inverse: {
            kind: 'restorePriorValues',
            operationId: operation.operationId,
          },
          ...(holdsWhile.length > 0 ? { holdsWhile } : {}),
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

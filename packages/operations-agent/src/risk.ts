/**
 * The risk class of an operation, derived only from facts its compiled
 * contract already carries (AGENT-3 slice 3; plan §9.4 "confirmation follows
 * the plan's risk class"). Never a hand list, never the model's word.
 *
 * | contract facts                                              | class      |
 * |-------------------------------------------------------------|------------|
 * | tier o0, create effect, confirmation none, the record type  | reversible |
 * |   has an o0 archive operation (the inverse: archive it)     |            |
 * | tier o0, update effect, confirmation none, takes a patch,   | reversible |
 * |   and no confirmed operation of the record type writes the  |            |
 * |   same fields (the inverse: the same update, prior values)  |            |
 * | anything else: o1 capabilities (they may move stock, post   | needsYes   |
 * |   money or change a document's state), archive, restore,    |            |
 * |   state transitions, confirmation humanRequired, an unknown |            |
 * |   tier or effect, a missing inverse                         |            |
 *
 * No contract carries a posting or outward flag today, so the pre-ruled
 * fallback holds: reversible is an O0 create or update only. A plan is
 * reversible only when every step is; one step needing a yes makes the plan
 * need a yes bound to exactly that plan.
 */
import type { RegisteredOperationDefinition } from '../../runtime/src/semantic-operation-gateway.js';

import { effectKind, localName, type PinnedCatalog } from './catalog.js';

export type RiskClass = 'reversible' | 'needsYes';

export interface OperationRisk {
  readonly riskClass: RiskClass;
  /** Why, in plain words, for the plan card and the record. */
  readonly reason: string;
  /** The inverse for a reversible operation. */
  readonly inverse?:
    | { readonly kind: 'archive'; readonly operationId: string }
    | { readonly kind: 'restorePriorValues'; readonly operationId: string };
}

export function operationRisk(
  catalog: PinnedCatalog,
  operation: RegisteredOperationDefinition,
): OperationRisk {
  const kind = effectKind(operation);
  const tier = (operation as { tier?: unknown }).tier;
  if (tier !== 'o0' && tier !== 'o1')
    return {
      riskClass: 'needsYes',
      reason: 'its operation family is not known',
    };
  if (tier === 'o1')
    return {
      riskClass: 'needsYes',
      reason:
        'it runs a registered business capability that may move stock, post money or change a document for good',
    };
  if (operation.confirmation !== 'none')
    return {
      riskClass: 'needsYes',
      reason: "the operation is declared to need the person's confirmation",
    };
  if (kind === 'createRecordEffect') {
    const entity = catalog.operationEntity(operation);
    const archive = catalog.operations.find(
      (candidate) =>
        effectKind(candidate) === 'archiveRecordEffect' &&
        (candidate as { tier?: unknown }).tier === 'o0' &&
        catalog.operationEntity(candidate) === entity,
    );
    return archive
      ? {
          riskClass: 'reversible',
          reason: `it creates a ${localName(entity).replaceAll('_', ' ')} record that Undo archives`,
          inverse: { kind: 'archive', operationId: archive.operationId },
        }
      : {
          riskClass: 'needsYes',
          reason: 'the record it creates has no archive operation to undo it',
        };
  }
  if (kind === 'updateRecordEffect') {
    const keys = operation.inputContract?.closedArgumentKeys ?? [];
    // A field another operation of the record type writes only with the
    // person's confirmation (a period's reopen) is guarded: changing it, or
    // putting it back, needs that confirmation too.
    const entity = catalog.operationEntity(operation);
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
        reason:
          "it changes a field that another operation changes only with the person's confirmation",
      };
    return keys.includes('patch') && keys.includes('expectedRevision')
      ? {
          riskClass: 'reversible',
          reason: 'it changes fields that Undo puts back',
          inverse: {
            kind: 'restorePriorValues',
            operationId: operation.operationId,
          },
        }
      : {
          riskClass: 'needsYes',
          reason: 'the change cannot be put back field by field',
        };
  }
  return {
    riskClass: 'needsYes',
    reason:
      kind === 'archiveRecordEffect'
        ? 'it archives a record'
        : kind === 'restoreRecordEffect'
          ? 'it restores an archived record'
          : kind === 'transitionStateEffect'
            ? "it changes a document's state"
            : 'its effect is not one Undo can reverse',
  };
}

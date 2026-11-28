import { z } from 'zod';

/**
 * OPEN-ITEM-1 declarations (see open-item.ts). Two optional v6 keys, each a
 * list, emitted only when declared.
 */
export interface OpenItemStates {
  readonly machineId: string;
  readonly draft: string;
  readonly open: string;
  readonly partiallySettled: string;
  readonly settled: string;
  readonly void: string;
}

export interface OpenItemDeclaration {
  readonly schemaVersion: 'v6';
  readonly entityId: string;
  /** Which subledger the item belongs to: one never applies to the other. */
  readonly direction: 'receivable' | 'payable';
  /** Relative to the counterparty: a charge is debit, a settlement credit. */
  readonly side: 'debit' | 'credit';
  readonly counterpartyRelationId: string;
  readonly currencyFieldId: string;
  readonly numberFieldId: string;
  readonly documentDateFieldId?: string | undefined;
  readonly dueDateFieldId?: string | undefined;
  readonly subtotalFieldId: string;
  readonly totalFieldId: string;
  readonly appliedFieldId: string;
  readonly balanceFieldId: string;
  /** An item with lines: their parent-scoped relation and stored amount. */
  readonly lines?:
    { readonly relationId: string; readonly amountFieldId: string } | undefined;
  /** A line-less item: the entered, draft-editable amount issue copies. */
  readonly amountFieldId?: string | undefined;
  readonly states: OpenItemStates;
  readonly issue: {
    readonly operationId: string;
    readonly transitionId: string;
  };
  /**
   * Withdraw an issued item nothing is applied to: the machine's transition
   * from open to void, moved only by the core. It keeps its number.
   */
  readonly void?:
    { readonly operationId: string; readonly transitionId: string } | undefined;
}

export interface OpenItemApplicationDeclaration {
  readonly schemaVersion: 'v6';
  readonly entityId: string;
  /** To the credit-side item the amount comes from. */
  readonly sourceRelationId: string;
  /** To the debit-side item it settles. */
  readonly targetRelationId: string;
  readonly amountFieldId: string;
  readonly applyOperationId: string;
  /** Withdraw application lines of one source: the amounts return. */
  readonly unapplyOperationId?: string | undefined;
}

export function openItemSchemas(canonicalId: z.ZodType<string>) {
  const declaration: z.ZodType<OpenItemDeclaration> = z.strictObject({
    schemaVersion: z.literal('v6'),
    entityId: canonicalId,
    direction: z.enum(['receivable', 'payable']),
    side: z.enum(['debit', 'credit']),
    counterpartyRelationId: canonicalId,
    currencyFieldId: canonicalId,
    numberFieldId: canonicalId,
    documentDateFieldId: canonicalId.optional(),
    dueDateFieldId: canonicalId.optional(),
    subtotalFieldId: canonicalId,
    totalFieldId: canonicalId,
    appliedFieldId: canonicalId,
    balanceFieldId: canonicalId,
    lines: z
      .strictObject({ relationId: canonicalId, amountFieldId: canonicalId })
      .optional(),
    amountFieldId: canonicalId.optional(),
    states: z.strictObject({
      machineId: canonicalId,
      draft: canonicalId,
      open: canonicalId,
      partiallySettled: canonicalId,
      settled: canonicalId,
      void: canonicalId,
    }),
    issue: z.strictObject({
      operationId: canonicalId,
      transitionId: canonicalId,
    }),
    void: z
      .strictObject({ operationId: canonicalId, transitionId: canonicalId })
      .optional(),
  });
  const application: z.ZodType<OpenItemApplicationDeclaration> = z.strictObject(
    {
      schemaVersion: z.literal('v6'),
      entityId: canonicalId,
      sourceRelationId: canonicalId,
      targetRelationId: canonicalId,
      amountFieldId: canonicalId,
      applyOperationId: canonicalId,
      unapplyOperationId: canonicalId.optional(),
    },
  );
  return {
    openItems: z.array(declaration).min(1).max(64).optional(),
    openItemApplications: z.array(application).min(1).max(64).optional(),
  };
}

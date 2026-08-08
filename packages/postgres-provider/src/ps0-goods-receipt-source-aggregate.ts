/**
 * PS-0 PROBE ONLY — NOT FOR MERGE.
 *
 * A goods-receipt-shaped foreign source aggregate driven through
 * `InventorySourceAggregateStepV1`. It exists to answer one question with a
 * running system rather than an argument: can a document aggregate outside the
 * Inventory family be locked, validated and transitioned inside the *same*
 * top-level transaction that takes the stock locks after `BEGIN`, so that a
 * concurrent second receipt cannot slip between validation and effect?
 *
 * Deliberate probe simplifications, each stated so no reading of the result can
 * quietly inherit them:
 *
 *  - The tables are probe-owned DDL, not compiled module storage, so they carry
 *    no RLS. Every statement scopes tenant/environment/legal entity explicitly,
 *    which is what the generated policies would also enforce.
 *  - The receipt plan is bound into the port instance. A real command family
 *    would carry it, and would need *two* expected-revision slots — the
 *    companion transaction's and the receipt's — where today's command shape
 *    has exactly one `sourceRevision`.
 *  - Movements still take their lineage from a companion `inventory_transaction`
 *    and its line, because `inventory_movement`'s relations to both are
 *    required. That is PS-0 ruling 3 in executable form, not an accident.
 */
import type { PoolClient } from 'pg';

import type {
  InventoryCompanionDerivationV1,
  InventorySourceAggregateStepV1,
} from './inventory-posting-service.js';
import type { InventoryPostingCommandV1 } from './inventory-posting-service.js';
import type { TrustedRequestContext } from '../../runtime/src/request-context.js';

export const PS0_RECEIPT_TABLES = Object.freeze({
  purchaseOrder: 'north_star_module.ps0_purchase_order',
  purchaseOrderLine: 'north_star_module.ps0_purchase_order_line',
  receipt: 'north_star_module.ps0_goods_receipt',
  receiptLine: 'north_star_module.ps0_goods_receipt_line',
});

export type Ps0SourceAggregateErrorCode =
  | 'PS0_RECEIPT_COST_EVIDENCE_MISSING'
  | 'PS0_RECEIPT_LINE_SET_CONFLICT'
  | 'PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED'
  | 'PS0_RECEIPT_STATE_CONFLICT'
  | 'PS0_PURCHASE_ORDER_STATE_CONFLICT';

export class Ps0SourceAggregateError extends Error {
  override readonly name = 'Ps0SourceAggregateError';

  constructor(
    readonly code: Ps0SourceAggregateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface Ps0ReceiptPlanLine {
  readonly purchaseOrderLineId: string;
  /** Signed. A compensating receipt carries the inverse of what it corrects. */
  readonly quantity: string;
}

export interface Ps0ReceiptPlan {
  readonly expectedReceiptRevision: number;
  readonly goodsReceiptId: string;
  readonly lines: readonly Ps0ReceiptPlanLine[];
  readonly purchaseOrderId: string;
}

/**
 * Each guard is a distinct load-bearing claim, switchable so a control can be
 * recorded red for the right reason rather than asserted in prose.
 */
export interface Ps0Guards {
  /** Compare-and-swap the observed received quantity when it is advanced. */
  readonly compareAndSwapReceived: boolean;
  /** Throw after the movements exist but before any purchasing row moves. */
  readonly failAfterMovements: boolean;
  /** Row-lock the purchase order and its lines during validation. */
  readonly lockPurchaseOrder: boolean;
}

export const PS0_ALL_GUARDS: Ps0Guards = Object.freeze({
  compareAndSwapReceived: true,
  failAfterMovements: false,
  lockPurchaseOrder: true,
});

interface ObservedLine {
  readonly orderedQuantity: string;
  readonly purchaseOrderLineId: string;
  readonly receivedQuantity: string;
}

export class Ps0GoodsReceiptSourceAggregate implements InventorySourceAggregateStepV1 {
  readonly familyId = 'goods_receipt';
  #observed: readonly ObservedLine[] = [];

  constructor(
    private readonly plan: Ps0ReceiptPlan,
    private readonly guards: Ps0Guards = PS0_ALL_GUARDS,
  ) {}

  /** ADR-0026 step 4/5 — every stock identity is already locked. */
  async lockAndValidate(
    client: PoolClient,
    context: TrustedRequestContext,
    command: InventoryPostingCommandV1,
  ): Promise<string> {
    const scope = [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
    ] as const;

    // Shared rows first, in a deterministic order, so two receipts against one
    // purchase order serialize on the order rather than on whichever line each
    // happens to touch first.
    const order = await client.query<{ state: string }>(
      `SELECT state
         FROM ${PS0_RECEIPT_TABLES.purchaseOrder}
        WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
          AND purchase_order_id=$4 AND archived_at IS NULL
        ${this.guards.lockPurchaseOrder ? 'FOR NO KEY UPDATE' : ''}`,
      [...scope, this.plan.purchaseOrderId],
    );
    if (order.rows[0]?.state !== 'released') {
      throw new Ps0SourceAggregateError(
        'PS0_PURCHASE_ORDER_STATE_CONFLICT',
        `purchase order ${this.plan.purchaseOrderId} is not released`,
      );
    }

    const observed = await client.query<ObservedLine>(
      `SELECT purchase_order_line_id AS "purchaseOrderLineId",
              ordered_quantity::text AS "orderedQuantity",
              received_quantity::text AS "receivedQuantity"
         FROM ${PS0_RECEIPT_TABLES.purchaseOrderLine}
        WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
          AND purchase_order_id=$4
          AND purchase_order_line_id = ANY($5::uuid[])
          AND archived_at IS NULL
        ORDER BY purchase_order_line_id
        ${this.guards.lockPurchaseOrder ? 'FOR NO KEY UPDATE' : ''}`,
      [
        ...scope,
        this.plan.purchaseOrderId,
        this.plan.lines.map((line) => line.purchaseOrderLineId),
      ],
    );
    if (observed.rows.length !== this.plan.lines.length) {
      throw new Ps0SourceAggregateError(
        'PS0_RECEIPT_LINE_SET_CONFLICT',
        'the receipt names a purchase-order line that is missing or archived',
      );
    }
    this.#observed = observed.rows;

    const receipt = await client.query<{ revision: number }>(
      `SELECT revision
         FROM ${PS0_RECEIPT_TABLES.receipt}
        WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
          AND goods_receipt_id=$4 AND purchase_order_id=$5
          AND state='draft' AND revision=$6 AND archived_at IS NULL
        FOR NO KEY UPDATE`,
      [
        ...scope,
        this.plan.goodsReceiptId,
        this.plan.purchaseOrderId,
        this.plan.expectedReceiptRevision,
      ],
    );
    if (receipt.rowCount !== 1) {
      throw new Ps0SourceAggregateError(
        'PS0_RECEIPT_STATE_CONFLICT',
        `goods receipt ${this.plan.goodsReceiptId} is not an active draft at revision ${String(this.plan.expectedReceiptRevision)}`,
      );
    }

    const lines = await client.query<{
      costAbsence: string | null;
      purchaseOrderLineId: string;
      quantity: string;
      unitCost: string | null;
    }>(
      `SELECT purchase_order_line_id AS "purchaseOrderLineId",
              quantity::text AS "quantity",
              unit_cost::text AS "unitCost",
              cost_absence AS "costAbsence"
         FROM ${PS0_RECEIPT_TABLES.receiptLine}
        WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
          AND goods_receipt_id=$4 AND archived_at IS NULL
        ORDER BY goods_receipt_line_id`,
      [...scope, this.plan.goodsReceiptId],
    );
    if (lines.rows.length !== this.plan.lines.length) {
      throw new Ps0SourceAggregateError(
        'PS0_RECEIPT_LINE_SET_CONFLICT',
        'the persisted receipt line set differs from the posting command',
      );
    }
    const plannedByLine = new Map(
      this.plan.lines.map((line) => [line.purchaseOrderLineId, line.quantity]),
    );
    for (const line of lines.rows) {
      // ADR-0017's G4 gate, made executable: actual cost or a declared absence,
      // never zero and never null-as-unknown.
      if ((line.unitCost === null) === (line.costAbsence === null)) {
        throw new Ps0SourceAggregateError(
          'PS0_RECEIPT_COST_EVIDENCE_MISSING',
          'a receipt line records neither an actual unit cost nor a declared absence',
        );
      }
      const planned = plannedByLine.get(line.purchaseOrderLineId);
      if (planned === undefined || !sameDecimal(planned, line.quantity)) {
        throw new Ps0SourceAggregateError(
          'PS0_RECEIPT_LINE_SET_CONFLICT',
          `receipt line for ${line.purchaseOrderLineId} does not match the posting command`,
        );
      }
    }

    const observedByLine = new Map(
      observed.rows.map((row) => [row.purchaseOrderLineId, row]),
    );
    for (const line of this.plan.lines) {
      const row = observedByLine.get(line.purchaseOrderLineId)!;
      const next = Number(row.receivedQuantity) + Number(line.quantity);
      if (next > Number(row.orderedQuantity) || next < 0) {
        throw new Ps0SourceAggregateError(
          'PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED',
          `receiving ${line.quantity} against line ${line.purchaseOrderLineId} leaves ${String(next)} received of ${row.orderedQuantity} ordered`,
        );
      }
    }

    return await this.#digest(client, scope);
  }

  /**
   * PS-2. Returns the companion's content; never writes it. The kernel is the
   * sole writer of `inventory_transaction`, as it is of the movement. Identity
   * and provenance are already derived in the kernel command under the profile,
   * so this port cannot choose either.
   */
  async deriveCompanion(
    _client: PoolClient,
    _context: TrustedRequestContext,
    command: InventoryPostingCommandV1,
  ): Promise<InventoryCompanionDerivationV1> {
    if (this.#observed.length === 0) {
      throw new Ps0SourceAggregateError(
        'PS0_RECEIPT_LINE_SET_CONFLICT',
        'deriveCompanion ran before the source aggregate was locked',
      );
    }
    return Object.freeze({
      effectiveAt: command.effectiveAt,
      lines: Object.freeze(
        command.lines.map((line, index) => {
          const quantity = 'quantityDelta' in line ? line.quantityDelta : '0';
          const negative = quantity.startsWith('-');
          const locationId = 'locationId' in line ? line.locationId : null;
          return Object.freeze({
            fromLocationId: negative ? locationId : null,
            itemId: line.itemId,
            lineNumber: String(index + 1),
            quantity,
            toLocationId: negative ? null : locationId,
            transactionLineId: line.transactionLineId,
            unitId: line.unitId,
          });
        }),
      ),
      number: `RCPT-${this.plan.goodsReceiptId.slice(0, 8)}`,
      reason: command.reason,
      sourceId: command.sourceId,
      sourceType: command.sourceType,
      transactionId: command.transactionId,
    });
  }

  /** ADR-0026 step 7 — inside the single post-lock savepoint. */
  async transition(
    client: PoolClient,
    context: TrustedRequestContext,
    command: InventoryPostingCommandV1,
    evidenceDigest: string,
    recordedAt: string,
  ): Promise<void> {
    if (this.guards.failAfterMovements) {
      throw new Ps0SourceAggregateError(
        'PS0_RECEIPT_STATE_CONFLICT',
        'injected failure after movements were appended',
      );
    }
    const scope = [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
    ] as const;
    const posted = await client.query(
      `UPDATE ${PS0_RECEIPT_TABLES.receipt}
          SET state='posted', revision=revision+1, recorded_at=$5::timestamptz
        WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
          AND goods_receipt_id=$4 AND state='draft' AND revision=$6
          AND archived_at IS NULL
          AND ${this.#digestSql('$1', '$2', '$3', '$4')} = $7`,
      [
        ...scope,
        this.plan.goodsReceiptId,
        recordedAt,
        this.plan.expectedReceiptRevision,
        evidenceDigest,
      ],
    );
    if (posted.rowCount !== 1) {
      throw new Ps0SourceAggregateError(
        'PS0_RECEIPT_STATE_CONFLICT',
        `goods receipt ${this.plan.goodsReceiptId} changed after validation`,
      );
    }
    const observedByLine = new Map(
      this.#observed.map((row) => [row.purchaseOrderLineId, row]),
    );
    for (const line of this.plan.lines) {
      const row = observedByLine.get(line.purchaseOrderLineId)!;
      const advanced = await client.query(
        `UPDATE ${PS0_RECEIPT_TABLES.purchaseOrderLine}
            SET received_quantity = received_quantity + $5::numeric,
                revision = revision + 1
          WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
            AND purchase_order_line_id=$4 AND archived_at IS NULL
            ${this.guards.compareAndSwapReceived ? 'AND received_quantity = $6::numeric' : ''}`,
        this.guards.compareAndSwapReceived
          ? [
              ...scope,
              line.purchaseOrderLineId,
              line.quantity,
              row.receivedQuantity,
            ]
          : [...scope, line.purchaseOrderLineId, line.quantity],
      );
      if (advanced.rowCount !== 1) {
        throw new Ps0SourceAggregateError(
          'PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED',
          `purchase-order line ${line.purchaseOrderLineId} changed after validation`,
        );
      }
    }
  }

  async #digest(
    client: PoolClient,
    scope: readonly [string, string, string],
  ): Promise<string> {
    const result = await client.query<{ digest: string }>(
      `SELECT ${this.#digestSql('$1', '$2', '$3', '$4')} AS digest`,
      [...scope, this.plan.goodsReceiptId],
    );
    const digest = result.rows[0]?.digest;
    if (!digest) {
      throw new Ps0SourceAggregateError(
        'PS0_RECEIPT_LINE_SET_CONFLICT',
        'the receipt line-set digest could not be captured',
      );
    }
    return digest;
  }

  #digestSql(
    tenant: string,
    environment: string,
    legalEntity: string,
    receipt: string,
  ): string {
    return `(SELECT md5(COALESCE(
                jsonb_agg(to_jsonb(line) ORDER BY line.goods_receipt_line_id::text)::text,
                '[]'
              ))
         FROM ${PS0_RECEIPT_TABLES.receiptLine} AS line
        WHERE line.tenant_id = ${tenant}
          AND line.environment_id = ${environment}
          AND line.legal_entity_id = ${legalEntity}
          AND line.goods_receipt_id = ${receipt}
          AND line.archived_at IS NULL)`;
  }
}

function sameDecimal(left: string, right: string): boolean {
  return Number(left) === Number(right);
}

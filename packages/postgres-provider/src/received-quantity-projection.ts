import type { PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { TrustedRequestContext } from '@north-star/runtime';
import {
  receiptBinding,
  receiptColumn,
  receiptDecimal,
  receiptError,
  receiptOption,
  receiptQuantity,
  receiptRelation,
  receiptTable,
  receivedIdentity,
  quoteReceiptIdentifier as q,
  type ReceiptBinding,
} from './goods-receipt.js';

type Scope = Pick<TrustedRequestContext, 'tenantId' | 'environmentId'> & {
  readonly legalEntityIds?: readonly string[];
};
export interface ReceivedFactRow {
  readonly recordId: string;
  readonly legalEntityId: string;
  readonly orderLineId: string;
  readonly quantity: string;
  readonly unitId: string;
}

/** Independent sweep: reads individual immutable movements and lineage, not the
 * maintained quantity and not the posting writer's SQL aggregate. */
export async function receivedFacts(
  client: PoolClient,
  binding: ReceiptBinding,
  scope: Scope,
): Promise<readonly ReceivedFactRow[]> {
  const m = binding.movement,
    l = binding.line,
    r = binding.receipt,
    o = binding.orderLine;
  const rows = await client.query(
    `SELECT m.record_id AS movement_id,m.${q(m.legalEntity!.column)} AS legal_entity_id,
    l.record_id AS receipt_line_id,l.${q(receiptColumn(l, 'goods_receipt_line_quantity'))}::text AS line_quantity,
    l.${q(receiptColumn(l, 'goods_receipt_line_unit_id'))} AS line_unit,
    l.${q(receiptColumn(l, 'goods_receipt_line_item_id'))} AS line_item,
    m.${q(receiptColumn(m, 'inventory_movement_item_id'))} AS movement_item,
    m.${q(receiptColumn(m, 'inventory_movement_posting_role'))} AS posting_role,
    r.${q(receiptColumn(r, 'goods_receipt_kind'))} AS receipt_kind,
    m.${q(receiptColumn(m, 'inventory_movement_quantity_delta'))}::text AS quantity,m.${q(receiptColumn(m, 'inventory_movement_unit_id'))} AS unit_id,
    l.${q(receiptRelation(binding, l, 'goods_receipt_line_order_line'))} AS order_line_id,
    r.${q(receiptColumn(r, 'goods_receipt_state'))} AS receipt_state,
    r.${q(receiptRelation(binding, r, 'goods_receipt_order'))} AS receipt_order,
    o.${q(receiptRelation(binding, o, 'purchase_order_line_order'))} AS line_order
    FROM ${receiptTable(m)} m
    LEFT JOIN ${receiptTable(l)} l ON l.tenant_id=m.tenant_id AND l.environment_id=m.environment_id AND l.${q(l.legalEntity!.column)}=m.${q(m.legalEntity!.column)} AND l.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_line'))}
    LEFT JOIN ${receiptTable(r)} r ON r.tenant_id=l.tenant_id AND r.environment_id=l.environment_id AND r.${q(r.legalEntity!.column)}=l.${q(l.legalEntity!.column)} AND r.record_id=l.${q(receiptRelation(binding, l, 'goods_receipt_line_receipt'))} AND r.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_id'))}
    LEFT JOIN ${receiptTable(o)} o ON o.tenant_id=l.tenant_id AND o.environment_id=l.environment_id AND o.${q(o.legalEntity!.column)}=l.${q(l.legalEntity!.column)} AND o.record_id=l.${q(receiptRelation(binding, l, 'goods_receipt_line_order_line'))}
    WHERE m.tenant_id=$1 AND m.environment_id=$2 AND ($3::uuid[] IS NULL OR m.${q(m.legalEntity!.column)}=ANY($3)) AND m.${q(receiptColumn(m, 'inventory_movement_source_type'))}='goodsReceipt' AND m.archived_at IS NULL ORDER BY m.record_id`,
    [scope.tenantId, scope.environmentId, scope.legalEntityIds ?? null],
  );
  const sums = new Map<
    string,
    {
      legalEntityId: string;
      orderLineId: string;
      quantity: bigint;
      unitId: string;
    }
  >();
  const seenLines = new Set<string>();
  for (const row of rows.rows) {
    if (
      !row.order_line_id ||
      !row.line_order ||
      row.receipt_order !== row.line_order ||
      row.receipt_state !== receiptOption(r, 'goods_receipt_state', 'posted') ||
      seenLines.has(String(row.receipt_line_id)) ||
      row.line_item !== row.movement_item ||
      row.line_unit !== row.unit_id ||
      receiptQuantity(String(row.line_quantity)) !==
        receiptQuantity(String(row.quantity)) ||
      row.posting_role !==
        receiptOption(m, 'inventory_movement_posting_role', 'receipt')
    )
      throw receiptError(
        'RECEIPT_PROJECTION_DIVERGED',
        'Movement has unrecoverable receipt/order attribution',
        { movementId: String(row.movement_id) },
      );
    seenLines.add(String(row.receipt_line_id));
    const id = receivedIdentity(
      scope,
      String(row.legal_entity_id),
      String(row.order_line_id),
    );
    const prior = sums.get(id);
    if (prior && prior.unitId !== row.unit_id)
      throw receiptError(
        'RECEIPT_PROJECTION_DIVERGED',
        'Order line has mixed movement units',
        { orderLineId: String(row.order_line_id) },
      );
    sums.set(id, {
      legalEntityId: String(row.legal_entity_id),
      orderLineId: String(row.order_line_id),
      quantity: (prior?.quantity ?? 0n) + receiptQuantity(String(row.quantity)),
      unitId: String(row.unit_id),
    });
  }
  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recordId, row]) => ({
      recordId,
      ...row,
      quantity: receiptDecimal(row.quantity),
    }));
}

export async function reconcileReceivedQuantities(
  client: PoolClient,
  binding: ReceiptBinding,
  scope: Scope,
) {
  const expected = await receivedFacts(client, binding, scope);
  const e = binding.received;
  const actual = await client.query(
    `SELECT * FROM ${receiptTable(e)} WHERE tenant_id=$1 AND environment_id=$2 AND ($3::uuid[] IS NULL OR ${q(e.legalEntity!.column)}=ANY($3)) AND archived_at IS NULL ORDER BY record_id`,
    [scope.tenantId, scope.environmentId, scope.legalEntityIds ?? null],
  );
  const expectedById = new Map(expected.map((row) => [row.recordId, row]));
  const actualById = new Map(
    actual.rows.map((row) => [String(row.record_id), row]),
  );
  const discrepancies = [];
  for (const id of [
    ...new Set([...expectedById.keys(), ...actualById.keys()]),
  ].sort()) {
    const fact = expectedById.get(id),
      stored = actualById.get(id);
    if (
      !fact ||
      !stored ||
      stored[e.legalEntity!.column] !== fact.legalEntityId ||
      stored[
        receiptRelation(binding, e, 'purchase_order_received_order_line')
      ] !== fact.orderLineId ||
      receiptQuantity(
        String(
          stored[receiptColumn(e, 'purchase_order_received_received_quantity')],
        ),
      ) !== receiptQuantity(fact.quantity) ||
      stored[receiptColumn(e, 'purchase_order_received_unit_id')] !==
        fact.unitId
    )
      discrepancies.push({
        recordId: id,
        stored: stored ?? null,
        recomputed: fact ?? null,
      });
  }
  return { expected, discrepancies, repaired: 0 as const };
}

/** Materializer-only. Its caller holds the exclusive aggregate-generation lock. */
export async function rebuildReceivedQuantitiesOnClient(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  scope: Scope,
): Promise<number> {
  const binding = receiptBinding(target);
  if (!binding) return 0;
  const comparison = await reconcileReceivedQuantities(client, binding, scope);
  for (const discrepancy of comparison.discrepancies)
    await client.query(
      `INSERT INTO north_star_internal.inventory_projection_discrepancies (tenant_id,environment_id,projection_entity_id,subject_identity,stored_row,recomputed_row) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        scope.tenantId,
        scope.environmentId,
        binding.received.entityId,
        JSON.stringify([discrepancy.recordId]),
        JSON.stringify(discrepancy.stored),
        JSON.stringify(discrepancy.recomputed),
      ],
    );
  const e = binding.received;
  await client.query(
    `UPDATE ${receiptTable(e)} SET archived_at=transaction_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL`,
    [scope.tenantId, scope.environmentId],
  );
  for (const row of comparison.expected)
    await client.query(
      `INSERT INTO ${receiptTable(e)} AS progress (tenant_id,environment_id,${q(e.legalEntity!.column)},record_id,revision,archived_at,${q(receiptRelation(binding, e, 'purchase_order_received_order_line'))},${q(receiptColumn(e, 'purchase_order_received_received_quantity'))},${q(receiptColumn(e, 'purchase_order_received_unit_id'))}) VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7) ON CONFLICT (tenant_id,environment_id,${q(e.legalEntity!.column)},record_id) DO UPDATE SET archived_at=NULL,revision=progress.revision+1,${q(receiptRelation(binding, e, 'purchase_order_received_order_line'))}=EXCLUDED.${q(receiptRelation(binding, e, 'purchase_order_received_order_line'))},${q(receiptColumn(e, 'purchase_order_received_received_quantity'))}=EXCLUDED.${q(receiptColumn(e, 'purchase_order_received_received_quantity'))},${q(receiptColumn(e, 'purchase_order_received_unit_id'))}=EXCLUDED.${q(receiptColumn(e, 'purchase_order_received_unit_id'))}`,
      [
        scope.tenantId,
        scope.environmentId,
        row.legalEntityId,
        row.recordId,
        row.orderLineId,
        row.quantity,
        row.unitId,
      ],
    );
  return comparison.expected.length;
}

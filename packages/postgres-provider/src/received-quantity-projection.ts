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

export interface StoredReceivedFactRow {
  readonly tenantId: string;
  readonly environmentId: string;
  readonly legalEntityId: string;
  readonly recordId: string;
  readonly orderLineId: string;
  readonly quantity: string;
  readonly unitId: string;
  readonly raw: Record<string, unknown>;
}

export interface ReceivedQuantityDiscrepancy {
  readonly recordId: string;
  readonly subjectIdentity: readonly [string, string, string, string];
  readonly stored: Record<string, unknown> | null;
  readonly recomputed: ReceivedFactRow | null;
}

function scopedReceivedKey(
  tenantId: string,
  environmentId: string,
  legalEntityId: string,
  recordId: string,
): string {
  return JSON.stringify([tenantId, environmentId, legalEntityId, recordId]);
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
  const add = (row: Record<string, unknown>) => {
    const aggregateIdentity = JSON.stringify([
      scope.tenantId,
      scope.environmentId,
      String(row.legal_entity_id),
      String(row.order_line_id),
    ]);
    const prior = sums.get(aggregateIdentity);
    if (prior && prior.unitId !== row.unit_id)
      throw receiptError(
        'RECEIPT_PROJECTION_DIVERGED',
        'Order line has mixed movement units',
        { orderLineId: String(row.order_line_id) },
      );
    sums.set(aggregateIdentity, {
      legalEntityId: String(row.legal_entity_id),
      orderLineId: String(row.order_line_id),
      quantity: (prior?.quantity ?? 0n) + receiptQuantity(String(row.quantity)),
      unitId: String(row.unit_id),
    });
  };
  for (const row of rows.rows) {
    const lineIdentity = JSON.stringify([
      scope.tenantId,
      scope.environmentId,
      String(row.legal_entity_id),
      String(row.receipt_line_id),
    ]);
    if (
      !row.order_line_id ||
      !row.line_order ||
      row.receipt_order !== row.line_order ||
      row.receipt_state !== receiptOption(r, 'goods_receipt_state', 'posted') ||
      seenLines.has(lineIdentity) ||
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
    seenLines.add(lineIdentity);
    add(row);
  }
  // RETURNS (ruling R-A): every posted vendor return is one negative movement
  // per return line, attributed to that line's order line. Read movement by
  // movement with its lineage, never through the posting writer's aggregate.
  const v = binding.vendorReturnLine,
    vr = binding.vendorReturn;
  if (v && vr) {
    const returns = await client.query(
      `SELECT m.record_id AS movement_id,m.${q(m.legalEntity!.column)} AS legal_entity_id,
      v.record_id AS return_line_id,v.${q(receiptColumn(v, 'vendor_return_line_quantity'))}::text AS line_quantity,
      v.${q(receiptColumn(v, 'vendor_return_line_unit_id'))} AS line_unit,
      v.${q(receiptColumn(v, 'vendor_return_line_item_id'))} AS line_item,
      m.${q(receiptColumn(m, 'inventory_movement_item_id'))} AS movement_item,
      m.${q(receiptColumn(m, 'inventory_movement_posting_role'))} AS posting_role,
      m.${q(receiptColumn(m, 'inventory_movement_quantity_delta'))}::text AS quantity,m.${q(receiptColumn(m, 'inventory_movement_unit_id'))} AS unit_id,
      v.${q(receiptRelation(binding, v, 'vendor_return_line_order_line'))} AS order_line_id,
      vr.${q(receiptColumn(vr, 'vendor_return_state'))} AS return_state,
      vr.${q(receiptRelation(binding, vr, 'vendor_return_order'))} AS return_order,
      o.${q(receiptRelation(binding, o, 'purchase_order_line_order'))} AS line_order
      FROM ${receiptTable(m)} m
      LEFT JOIN ${receiptTable(v)} v ON v.tenant_id=m.tenant_id AND v.environment_id=m.environment_id AND v.${q(v.legalEntity!.column)}=m.${q(m.legalEntity!.column)} AND v.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_line'))}
      LEFT JOIN ${receiptTable(vr)} vr ON vr.tenant_id=v.tenant_id AND vr.environment_id=v.environment_id AND vr.${q(vr.legalEntity!.column)}=v.${q(v.legalEntity!.column)} AND vr.record_id=v.${q(receiptRelation(binding, v, 'vendor_return_line_return'))} AND vr.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_id'))}
      LEFT JOIN ${receiptTable(o)} o ON o.tenant_id=v.tenant_id AND o.environment_id=v.environment_id AND o.${q(o.legalEntity!.column)}=v.${q(v.legalEntity!.column)} AND o.record_id=v.${q(receiptRelation(binding, v, 'vendor_return_line_order_line'))}
      WHERE m.tenant_id=$1 AND m.environment_id=$2 AND ($3::uuid[] IS NULL OR m.${q(m.legalEntity!.column)}=ANY($3)) AND m.${q(receiptColumn(m, 'inventory_movement_source_type'))}='vendorReturn' AND m.archived_at IS NULL ORDER BY m.record_id`,
      [scope.tenantId, scope.environmentId, scope.legalEntityIds ?? null],
    );
    for (const row of returns.rows) {
      const lineIdentity = JSON.stringify([
        scope.tenantId,
        scope.environmentId,
        String(row.legal_entity_id),
        'vendorReturn',
        String(row.return_line_id),
      ]);
      if (
        !row.order_line_id ||
        !row.line_order ||
        row.return_order !== row.line_order ||
        row.return_state !==
          receiptOption(vr, 'vendor_return_state', 'posted') ||
        seenLines.has(lineIdentity) ||
        row.line_item !== row.movement_item ||
        row.line_unit !== row.unit_id ||
        -receiptQuantity(String(row.line_quantity)) !==
          receiptQuantity(String(row.quantity)) ||
        row.posting_role !==
          receiptOption(m, 'inventory_movement_posting_role', 'vendor_return')
      )
        throw receiptError(
          'RECEIPT_PROJECTION_DIVERGED',
          'Movement has unrecoverable vendor return/order attribution',
          { movementId: String(row.movement_id) },
        );
      seenLines.add(lineIdentity);
      add(row);
    }
  }
  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => ({
      recordId: receivedIdentity(scope, row.legalEntityId, row.orderLineId),
      ...row,
      quantity: receiptDecimal(row.quantity),
    }));
}

/** Rebuild writer: an independent SQL aggregation over persisted immutable
 * facts. It deliberately does not call the reconciliation traversal above. */
async function reconstructedReceivedFacts(
  client: PoolClient,
  binding: ReceiptBinding,
  scope: Scope,
): Promise<readonly ReceivedFactRow[]> {
  const m = binding.movement,
    l = binding.line,
    r = binding.receipt,
    o = binding.orderLine,
    v = binding.vendorReturnLine,
    vr = binding.vendorReturn;
  const receipts = `SELECT m.${q(m.legalEntity!.column)} AS legal_entity_id,
            l.${q(receiptRelation(binding, l, 'goods_receipt_line_order_line'))}::text AS order_line_id,
            m.${q(receiptColumn(m, 'inventory_movement_quantity_delta'))} AS quantity,
            m.${q(receiptColumn(m, 'inventory_movement_unit_id'))} AS unit_id
       FROM ${receiptTable(m)} m
       JOIN ${receiptTable(l)} l
         ON l.tenant_id=m.tenant_id
        AND l.environment_id=m.environment_id
        AND l.${q(l.legalEntity!.column)}=m.${q(m.legalEntity!.column)}
        AND l.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_line'))}
       JOIN ${receiptTable(r)} r
         ON r.tenant_id=l.tenant_id
        AND r.environment_id=l.environment_id
        AND r.${q(r.legalEntity!.column)}=l.${q(l.legalEntity!.column)}
        AND r.record_id=l.${q(receiptRelation(binding, l, 'goods_receipt_line_receipt'))}
        AND r.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_id'))}
       JOIN ${receiptTable(o)} o
         ON o.tenant_id=l.tenant_id
        AND o.environment_id=l.environment_id
        AND o.${q(o.legalEntity!.column)}=l.${q(l.legalEntity!.column)}
        AND o.record_id=l.${q(receiptRelation(binding, l, 'goods_receipt_line_order_line'))}
      WHERE m.tenant_id=$1
        AND m.environment_id=$2
        AND ($3::uuid[] IS NULL OR m.${q(m.legalEntity!.column)}=ANY($3))
        AND m.${q(receiptColumn(m, 'inventory_movement_source_type'))}='goodsReceipt'
        AND m.archived_at IS NULL
        AND r.${q(receiptColumn(r, 'goods_receipt_state'))}=$4
        AND r.${q(receiptRelation(binding, r, 'goods_receipt_order'))}=o.${q(receiptRelation(binding, o, 'purchase_order_line_order'))}
        AND l.${q(receiptColumn(l, 'goods_receipt_line_item_id'))}::text=m.${q(receiptColumn(m, 'inventory_movement_item_id'))}::text
        AND l.${q(receiptColumn(l, 'goods_receipt_line_unit_id'))}=m.${q(receiptColumn(m, 'inventory_movement_unit_id'))}
        AND l.${q(receiptColumn(l, 'goods_receipt_line_quantity'))}=m.${q(receiptColumn(m, 'inventory_movement_quantity_delta'))}
        AND m.${q(receiptColumn(m, 'inventory_movement_posting_role'))}=$5`;
  // RETURNS (ruling R-A): each posted vendor return line's one negative
  // movement, joined through its own return and order line.
  const vendorReturns =
    v && vr
      ? `SELECT m.${q(m.legalEntity!.column)} AS legal_entity_id,
            v.${q(receiptRelation(binding, v, 'vendor_return_line_order_line'))}::text AS order_line_id,
            m.${q(receiptColumn(m, 'inventory_movement_quantity_delta'))} AS quantity,
            m.${q(receiptColumn(m, 'inventory_movement_unit_id'))} AS unit_id
       FROM ${receiptTable(m)} m
       JOIN ${receiptTable(v)} v
         ON v.tenant_id=m.tenant_id
        AND v.environment_id=m.environment_id
        AND v.${q(v.legalEntity!.column)}=m.${q(m.legalEntity!.column)}
        AND v.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_line'))}
       JOIN ${receiptTable(vr)} vr
         ON vr.tenant_id=v.tenant_id
        AND vr.environment_id=v.environment_id
        AND vr.${q(vr.legalEntity!.column)}=v.${q(v.legalEntity!.column)}
        AND vr.record_id=v.${q(receiptRelation(binding, v, 'vendor_return_line_return'))}
        AND vr.record_id::text=m.${q(receiptColumn(m, 'inventory_movement_source_id'))}
       JOIN ${receiptTable(o)} o
         ON o.tenant_id=v.tenant_id
        AND o.environment_id=v.environment_id
        AND o.${q(o.legalEntity!.column)}=v.${q(v.legalEntity!.column)}
        AND o.record_id=v.${q(receiptRelation(binding, v, 'vendor_return_line_order_line'))}
      WHERE m.tenant_id=$1
        AND m.environment_id=$2
        AND ($3::uuid[] IS NULL OR m.${q(m.legalEntity!.column)}=ANY($3))
        AND m.${q(receiptColumn(m, 'inventory_movement_source_type'))}='vendorReturn'
        AND m.archived_at IS NULL
        AND vr.${q(receiptColumn(vr, 'vendor_return_state'))}=$6
        AND vr.${q(receiptRelation(binding, vr, 'vendor_return_order'))}=o.${q(receiptRelation(binding, o, 'purchase_order_line_order'))}
        AND v.${q(receiptColumn(v, 'vendor_return_line_item_id'))}::text=m.${q(receiptColumn(m, 'inventory_movement_item_id'))}::text
        AND v.${q(receiptColumn(v, 'vendor_return_line_unit_id'))}=m.${q(receiptColumn(m, 'inventory_movement_unit_id'))}
        AND -v.${q(receiptColumn(v, 'vendor_return_line_quantity'))}=m.${q(receiptColumn(m, 'inventory_movement_quantity_delta'))}
        AND m.${q(receiptColumn(m, 'inventory_movement_posting_role'))}=$7`
      : null;
  const result = await client.query<{
    legal_entity_id: string;
    order_line_id: string;
    quantity: string;
    unit_id: string;
    unit_count: string;
  }>(
    `SELECT facts.legal_entity_id,
            facts.order_line_id,
            sum(facts.quantity)::numeric(38,18)::text AS quantity,
            min(facts.unit_id) AS unit_id,
            count(DISTINCT facts.unit_id)::text AS unit_count
       FROM (${receipts}${vendorReturns ? ` UNION ALL ${vendorReturns}` : ''}) facts
      GROUP BY 1,2
      ORDER BY 1,2`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityIds ?? null,
      receiptOption(r, 'goods_receipt_state', 'posted'),
      receiptOption(m, 'inventory_movement_posting_role', 'receipt'),
      ...(v && vr
        ? [
            receiptOption(vr, 'vendor_return_state', 'posted'),
            receiptOption(
              m,
              'inventory_movement_posting_role',
              'vendor_return',
            ),
          ]
        : []),
    ],
  );
  return result.rows.map((row) => {
    if (Number(row.unit_count) !== 1)
      throw receiptError(
        'RECEIPT_PROJECTION_DIVERGED',
        'Order line has mixed movement units',
        { orderLineId: row.order_line_id },
      );
    return {
      legalEntityId: row.legal_entity_id,
      orderLineId: row.order_line_id,
      quantity: receiptDecimal(receiptQuantity(String(row.quantity))),
      recordId: receivedIdentity(scope, row.legal_entity_id, row.order_line_id),
      unitId: row.unit_id,
    };
  });
}

export function compareReceivedQuantityRows(
  scope: Pick<Scope, 'tenantId' | 'environmentId'>,
  expected: readonly ReceivedFactRow[],
  actual: readonly StoredReceivedFactRow[],
): readonly ReceivedQuantityDiscrepancy[] {
  const expectedByIdentity = new Map<string, ReceivedFactRow>();
  for (const row of expected) {
    const key = scopedReceivedKey(
      scope.tenantId,
      scope.environmentId,
      row.legalEntityId,
      row.recordId,
    );
    if (expectedByIdentity.has(key))
      throw receiptError(
        'RECEIPT_PROJECTION_DIVERGED',
        'Recomputed receipt facts contain duplicate scoped identity',
      );
    expectedByIdentity.set(key, row);
  }
  const actualByIdentity = new Map<string, StoredReceivedFactRow>();
  for (const row of actual) {
    const key = scopedReceivedKey(
      row.tenantId,
      row.environmentId,
      row.legalEntityId,
      row.recordId,
    );
    if (actualByIdentity.has(key))
      throw receiptError(
        'RECEIPT_PROJECTION_DIVERGED',
        'Stored received projection contains duplicate scoped identity',
      );
    actualByIdentity.set(key, row);
  }
  const discrepancies: ReceivedQuantityDiscrepancy[] = [];
  for (const key of [
    ...new Set([...expectedByIdentity.keys(), ...actualByIdentity.keys()]),
  ].sort()) {
    const fact = expectedByIdentity.get(key);
    const stored = actualByIdentity.get(key);
    if (
      !fact ||
      !stored ||
      stored.orderLineId !== fact.orderLineId ||
      receiptQuantity(stored.quantity) !== receiptQuantity(fact.quantity) ||
      stored.unitId !== fact.unitId
    ) {
      const identity = stored ?? fact!;
      discrepancies.push({
        recordId: identity.recordId,
        subjectIdentity: [
          stored?.tenantId ?? scope.tenantId,
          stored?.environmentId ?? scope.environmentId,
          identity.legalEntityId,
          identity.recordId,
        ],
        stored: stored?.raw ?? null,
        recomputed: fact ?? null,
      });
    }
  }
  return discrepancies;
}

export async function reconcileReceivedQuantities(
  client: PoolClient,
  binding: ReceiptBinding,
  scope: Scope,
) {
  const expected = await receivedFacts(client, binding, scope);
  const e = binding.received;
  const actual = await client.query(
    `SELECT tenant_id,environment_id,${q(e.legalEntity!.column)} AS legal_entity_id,record_id,
            ${q(receiptRelation(binding, e, 'purchase_order_received_order_line'))}::text AS order_line_id,
            ${q(receiptColumn(e, 'purchase_order_received_received_quantity'))}::text AS quantity,
            ${q(receiptColumn(e, 'purchase_order_received_unit_id'))} AS unit_id,
            to_jsonb(progress) AS raw
       FROM ${receiptTable(e)} progress
      WHERE tenant_id=$1 AND environment_id=$2
        AND ($3::uuid[] IS NULL OR ${q(e.legalEntity!.column)}=ANY($3))
        AND archived_at IS NULL
      ORDER BY record_id,${q(e.legalEntity!.column)}`,
    [scope.tenantId, scope.environmentId, scope.legalEntityIds ?? null],
  );
  const discrepancies = compareReceivedQuantityRows(
    scope,
    expected,
    actual.rows.map((row) => ({
      environmentId: String(row.environment_id),
      legalEntityId: String(row.legal_entity_id),
      orderLineId: String(row.order_line_id),
      quantity: String(row.quantity),
      raw: row.raw as Record<string, unknown>,
      recordId: String(row.record_id),
      tenantId: String(row.tenant_id),
      unitId: String(row.unit_id),
    })),
  );
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
  const reconstruction = await reconstructedReceivedFacts(
    client,
    binding,
    scope,
  );
  for (const discrepancy of comparison.discrepancies)
    await client.query(
      `INSERT INTO north_star_internal.inventory_projection_discrepancies (tenant_id,environment_id,projection_entity_id,subject_identity,stored_row,recomputed_row) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        scope.tenantId,
        scope.environmentId,
        binding.received.entityId,
        JSON.stringify(discrepancy.subjectIdentity),
        JSON.stringify(discrepancy.stored),
        JSON.stringify(discrepancy.recomputed),
      ],
    );
  const e = binding.received;
  await client.query(
    `UPDATE ${receiptTable(e)} SET archived_at=transaction_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND environment_id=$2 AND ($3::uuid[] IS NULL OR ${q(e.legalEntity!.column)}=ANY($3)) AND archived_at IS NULL`,
    [scope.tenantId, scope.environmentId, scope.legalEntityIds ?? null],
  );
  for (const row of reconstruction)
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
  const verification = await reconcileReceivedQuantities(
    client,
    binding,
    scope,
  );
  if (verification.discrepancies.length > 0)
    throw receiptError(
      'RECEIPT_PROJECTION_DIVERGED',
      'Rebuilt received projection failed independent verification',
      { discrepancyCount: String(verification.discrepancies.length) },
    );
  return reconstruction.length;
}

import type { PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { TrustedRequestContext } from '@north-star/runtime';
import {
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentDecimal,
  fulfillmentError,
  fulfillmentOption,
  fulfillmentProjectionIdentity,
  fulfillmentQuantity,
  fulfillmentRelation,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
  type FulfillmentBinding,
} from './fulfillment.js';

type Scope = Pick<TrustedRequestContext, 'tenantId' | 'environmentId'> & {
  readonly legalEntityIds?: readonly string[];
};
export interface FulfillmentProjectionFact {
  readonly family: 'reservation' | 'shipped';
  readonly legalEntityId: string;
  readonly recordId: string;
  readonly sourceId: string;
  readonly quantity: string;
  readonly unitId: string;
}
export interface FulfillmentProjectionDiscrepancy {
  readonly projectionEntityId: string;
  readonly subjectIdentity: readonly [string, string, string, string];
  readonly stored: Record<string, unknown> | null;
  readonly recomputed: FulfillmentProjectionFact | null;
}

const identity = (
  scope: Scope,
  row: Pick<FulfillmentProjectionFact, 'family' | 'legalEntityId' | 'recordId'>,
) =>
  JSON.stringify([
    scope.tenantId,
    scope.environmentId,
    row.legalEntityId,
    row.family,
    row.recordId,
  ]);

/** Independent read-only reconstruction from immutable shipment movements. */
export async function fulfillmentProjectionFacts(
  client: PoolClient,
  b: FulfillmentBinding,
  scope: Scope,
): Promise<readonly FulfillmentProjectionFact[]> {
  const r = b.reservation;
  const sl = b.shipmentLine;
  const m = b.movement;
  const reservationRows = await client.query<{
    legal_entity_id: string;
    quantity: string;
    record_id: string;
    state: string;
    unit_id: string;
  }>(
    `SELECT r.${q(r.legalEntity!.column)}::text AS legal_entity_id,r.record_id::text,
            r.${q(fulfillmentColumn(r, 'reservation_state'))} AS state,
            r.${q(fulfillmentColumn(r, 'reservation_unit_id'))} AS unit_id,
            (r.${q(fulfillmentColumn(r, 'reservation_quantity'))}+
             coalesce(sum(m.${q(fulfillmentColumn(m, 'inventory_movement_quantity_delta'))}),0))::text AS quantity
       FROM ${fulfillmentTable(r)} r
       LEFT JOIN ${fulfillmentTable(sl)} sl
         ON sl.tenant_id=r.tenant_id AND sl.environment_id=r.environment_id
        AND sl.${q(sl.legalEntity!.column)}=r.${q(r.legalEntity!.column)}
        AND sl.${q(fulfillmentRelation(b, sl, 'shipment_line_reservation'))}=r.record_id
        AND sl.archived_at IS NULL
       LEFT JOIN ${fulfillmentTable(m)} m
         ON m.tenant_id=sl.tenant_id AND m.environment_id=sl.environment_id
        AND m.${q(m.legalEntity!.column)}=sl.${q(sl.legalEntity!.column)}
        AND m.${q(fulfillmentColumn(m, 'inventory_movement_source_type'))}='shipment'
        AND m.${q(fulfillmentColumn(m, 'inventory_movement_source_line'))}=sl.record_id::text
        AND m.archived_at IS NULL
      WHERE r.tenant_id=$1 AND r.environment_id=$2
        AND ($3::uuid[] IS NULL OR r.${q(r.legalEntity!.column)}=ANY($3))
        AND r.archived_at IS NULL
        AND r.${q(fulfillmentColumn(r, 'reservation_state'))}<>$4
      GROUP BY r.${q(r.legalEntity!.column)},r.record_id,
               r.${q(fulfillmentColumn(r, 'reservation_state'))},
               r.${q(fulfillmentColumn(r, 'reservation_unit_id'))},
               r.${q(fulfillmentColumn(r, 'reservation_quantity'))}
      ORDER BY 1,2`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityIds ?? null,
      fulfillmentOption(r, 'reservation_state', 'draft'),
    ],
  );
  const shippedRows = await client.query<{
    legal_entity_id: string;
    order_line_id: string;
    quantity: string;
    unit_id: string;
    unit_count: string;
  }>(
    `SELECT m.${q(m.legalEntity!.column)}::text AS legal_entity_id,
            sl.${q(fulfillmentRelation(b, sl, 'shipment_line_order_line'))}::text AS order_line_id,
            (-sum(m.${q(fulfillmentColumn(m, 'inventory_movement_quantity_delta'))}))::text AS quantity,
            min(m.${q(fulfillmentColumn(m, 'inventory_movement_unit_id'))}) AS unit_id,
            count(DISTINCT m.${q(fulfillmentColumn(m, 'inventory_movement_unit_id'))})::text AS unit_count
       FROM ${fulfillmentTable(m)} m
       JOIN ${fulfillmentTable(sl)} sl
         ON sl.tenant_id=m.tenant_id AND sl.environment_id=m.environment_id
        AND sl.${q(sl.legalEntity!.column)}=m.${q(m.legalEntity!.column)}
        AND sl.record_id::text=m.${q(fulfillmentColumn(m, 'inventory_movement_source_line'))}
      WHERE m.tenant_id=$1 AND m.environment_id=$2
        AND ($3::uuid[] IS NULL OR m.${q(m.legalEntity!.column)}=ANY($3))
        AND m.${q(fulfillmentColumn(m, 'inventory_movement_source_type'))}='shipment'
        AND m.${q(fulfillmentColumn(m, 'inventory_movement_posting_role'))}=$4
        AND m.archived_at IS NULL
      GROUP BY 1,2 ORDER BY 1,2`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityIds ?? null,
      fulfillmentOption(m, 'inventory_movement_posting_role', 'shipment'),
    ],
  );
  const facts: FulfillmentProjectionFact[] = reservationRows.rows.map(
    (row) => ({
      family: 'reservation',
      legalEntityId: row.legal_entity_id,
      quantity:
        row.state === fulfillmentOption(r, 'reservation_state', 'released')
          ? '0'
          : fulfillmentDecimal(fulfillmentQuantity(row.quantity)),
      recordId: fulfillmentProjectionIdentity(
        scope,
        row.legal_entity_id,
        'reservation',
        row.record_id,
      ),
      sourceId: row.record_id,
      unitId: row.unit_id,
    }),
  );
  for (const row of shippedRows.rows) {
    if (Number(row.unit_count) !== 1)
      throw fulfillmentError(
        'FULFILLMENT_PROJECTION_DIVERGED',
        'Order line has mixed shipment units',
        { orderLineId: row.order_line_id },
      );
    facts.push({
      family: 'shipped',
      legalEntityId: row.legal_entity_id,
      quantity: fulfillmentDecimal(fulfillmentQuantity(row.quantity)),
      recordId: fulfillmentProjectionIdentity(
        scope,
        row.legal_entity_id,
        'shipped',
        row.order_line_id,
      ),
      sourceId: row.order_line_id,
      unitId: row.unit_id,
    });
  }
  return facts.sort((a, z) =>
    identity(scope, a).localeCompare(identity(scope, z)),
  );
}

async function storedFacts(
  client: PoolClient,
  b: FulfillmentBinding,
  scope: Scope,
) {
  const facts: Array<
    FulfillmentProjectionFact & { raw: Record<string, unknown> }
  > = [];
  const descriptions = [
    [
      'reservation',
      b.reservationBalance,
      'reservation_balance_reservation',
      'reservation_balance_remaining_quantity',
      'reservation_balance_unit_id',
    ],
    [
      'shipped',
      b.shipped,
      'sales_order_shipped_order_line',
      'sales_order_shipped_shipped_quantity',
      'sales_order_shipped_unit_id',
    ],
  ] as const;
  for (const [family, entity, relation, quantity, unit] of descriptions) {
    const rows = await client.query<Record<string, unknown>>(
      `SELECT row.*,row.${q(entity.legalEntity!.column)}::text AS legal,
              row.${q(fulfillmentRelation(b, entity, relation))}::text AS source,
              row.${q(fulfillmentColumn(entity, quantity))}::text AS amount,
              row.${q(fulfillmentColumn(entity, unit))} AS unit,to_jsonb(row) AS raw
         FROM ${fulfillmentTable(entity)} row
        WHERE tenant_id=$1 AND environment_id=$2
          AND ($3::uuid[] IS NULL OR row.${q(entity.legalEntity!.column)}=ANY($3))
          AND archived_at IS NULL`,
      [scope.tenantId, scope.environmentId, scope.legalEntityIds ?? null],
    );
    for (const row of rows.rows)
      facts.push({
        family,
        legalEntityId: String(row.legal),
        quantity: String(row.amount),
        raw: row.raw as Record<string, unknown>,
        recordId: String(row.record_id),
        sourceId: String(row.source),
        unitId: String(row.unit),
      });
  }
  return facts;
}

export async function reconcileFulfillmentProjections(
  client: PoolClient,
  b: FulfillmentBinding,
  scope: Scope,
) {
  const expected = await fulfillmentProjectionFacts(client, b, scope);
  const actual = await storedFacts(client, b, scope);
  const wanted = new Map(expected.map((row) => [identity(scope, row), row]));
  const found = new Map(actual.map((row) => [identity(scope, row), row]));
  const discrepancies: FulfillmentProjectionDiscrepancy[] = [];
  for (const id of [...new Set([...wanted.keys(), ...found.keys()])].sort()) {
    const fact = wanted.get(id);
    const stored = found.get(id);
    if (
      !fact ||
      !stored ||
      fact.sourceId !== stored.sourceId ||
      fulfillmentQuantity(fact.quantity) !==
        fulfillmentQuantity(stored.quantity) ||
      fact.unitId !== stored.unitId
    ) {
      const subject = fact ?? stored!;
      discrepancies.push({
        projectionEntityId:
          subject.family === 'reservation'
            ? b.reservationBalance.entityId
            : b.shipped.entityId,
        recomputed: fact ?? null,
        stored: stored?.raw ?? null,
        subjectIdentity: [
          scope.tenantId,
          scope.environmentId,
          subject.legalEntityId,
          subject.recordId,
        ],
      });
    }
  }
  return { discrepancies, expected, repaired: 0 as const };
}

/** Materializer-only scoped repair. Discrepancies are persisted first. */
export async function rebuildFulfillmentProjectionsOnClient(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  scope: Scope,
): Promise<number> {
  const b = fulfillmentBinding(target);
  if (!b) return 0;
  const comparison = await reconcileFulfillmentProjections(client, b, scope);
  for (const discrepancy of comparison.discrepancies)
    await client.query(
      `INSERT INTO north_star_internal.inventory_projection_discrepancies
       (tenant_id,environment_id,projection_entity_id,subject_identity,stored_row,recomputed_row)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        scope.tenantId,
        scope.environmentId,
        discrepancy.projectionEntityId,
        JSON.stringify(discrepancy.subjectIdentity),
        JSON.stringify(discrepancy.stored),
        JSON.stringify(discrepancy.recomputed),
      ],
    );
  for (const entity of [b.reservationBalance, b.shipped])
    await client.query(
      `UPDATE ${fulfillmentTable(entity)} SET archived_at=transaction_timestamp(),revision=revision+1
        WHERE tenant_id=$1 AND environment_id=$2
          AND ($3::uuid[] IS NULL OR ${q(entity.legalEntity!.column)}=ANY($3))
          AND archived_at IS NULL`,
      [scope.tenantId, scope.environmentId, scope.legalEntityIds ?? null],
    );
  // Repair writes the immutable-fact reconstruction, never the stored rows.
  for (const row of comparison.expected) {
    const entity =
      row.family === 'reservation' ? b.reservationBalance : b.shipped;
    const relation =
      row.family === 'reservation'
        ? 'reservation_balance_reservation'
        : 'sales_order_shipped_order_line';
    const quantity =
      row.family === 'reservation'
        ? 'reservation_balance_remaining_quantity'
        : 'sales_order_shipped_shipped_quantity';
    const unit =
      row.family === 'reservation'
        ? 'reservation_balance_unit_id'
        : 'sales_order_shipped_unit_id';
    await client.query(
      `INSERT INTO ${fulfillmentTable(entity)} AS p
       (tenant_id,environment_id,${q(entity.legalEntity!.column)},record_id,revision,archived_at,
        ${q(fulfillmentRelation(b, entity, relation))},${q(fulfillmentColumn(entity, quantity))},${q(fulfillmentColumn(entity, unit))})
       VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7)
       ON CONFLICT (tenant_id,environment_id,${q(entity.legalEntity!.column)},record_id)
       DO UPDATE SET archived_at=NULL,revision=p.revision+1,
        ${q(fulfillmentRelation(b, entity, relation))}=EXCLUDED.${q(fulfillmentRelation(b, entity, relation))},
        ${q(fulfillmentColumn(entity, quantity))}=EXCLUDED.${q(fulfillmentColumn(entity, quantity))},
        ${q(fulfillmentColumn(entity, unit))}=EXCLUDED.${q(fulfillmentColumn(entity, unit))}`,
      [
        scope.tenantId,
        scope.environmentId,
        row.legalEntityId,
        row.recordId,
        row.sourceId,
        row.quantity,
        row.unitId,
      ],
    );
  }
  const verification = await reconcileFulfillmentProjections(client, b, scope);
  if (verification.discrepancies.length)
    throw fulfillmentError(
      'FULFILLMENT_PROJECTION_DIVERGED',
      'Rebuilt fulfillment projections failed independent verification',
      { discrepancyCount: String(verification.discrepancies.length) },
    );
  return comparison.expected.length;
}

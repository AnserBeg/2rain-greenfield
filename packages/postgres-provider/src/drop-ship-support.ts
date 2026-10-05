import type { PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import { parseExact } from './commercial-amounts.js';
import { InventoryPostingError } from './inventory-posting-error.js';

export type DropShipEntity = StorageTargetPayloadV1['entities'][number];
export type DropShipRow = Record<string, unknown>;
export type DropShipScope = Readonly<{
  tenantId: string;
  environmentId: string;
  legalEntityId: string;
}>;
export function dropShipRefused(message: string): never {
  throw new InventoryPostingError('INVENTORY_POSTING_INPUT_INVALID', message);
}
export function dropShipQuote(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error('Invalid storage identifier');
  return `"${value}"`;
}
export const dropShipTable = (entity: DropShipEntity) =>
  `north_star_module.${dropShipQuote(entity.physicalTableName)}`;
export function dropShipEntity(
  storage: StorageTargetPayloadV1,
  local: string,
): DropShipEntity {
  const found = storage.entities.filter((entry) =>
    entry.entityId.endsWith(`:entity.${local}`),
  );
  if (found.length !== 1) dropShipRefused(`Expected one ${local} entity`);
  return found[0]!;
}
export function dropShipColumn(entity: DropShipEntity, local: string): string {
  const found = entity.columns.find(
    (entry) =>
      entry.canonicalFieldId.endsWith(`:field.${local}`) ||
      entry.canonicalFieldId.endsWith(`:${local}`),
  );
  if (!found) dropShipRefused(`Missing field ${local}`);
  return found.physicalName;
}
export function dropShipRelation(
  storage: StorageTargetPayloadV1,
  local: string,
): string {
  const found = storage.relations.find((entry) =>
    entry.relationId.endsWith(`:relation.${local}`),
  );
  if (!found) dropShipRefused(`Missing relation ${local}`);
  return found.relationColumn.physicalName;
}
export function dropShipQuantity(value: unknown): bigint {
  const parsed = parseExact(value);
  if (!parsed || parsed.scale > 18 || parsed.units < 0n)
    dropShipRefused('Quantity must be an exact non-negative decimal');
  return parsed.units * 10n ** BigInt(18 - parsed.scale);
}
export function dropShipQuantityText(value: bigint): string {
  const scale = 10n ** 18n;
  const tail = (value % scale).toString().padStart(18, '0').replace(/0+$/u, '');
  return `${value / scale}${tail ? `.${tail}` : ''}`;
}
export function dropShipRevision(value: unknown): number {
  const revision =
    typeof value === 'number' || typeof value === 'string'
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(revision) || revision <= 0)
    dropShipRefused('Stored record revision must be a positive safe integer');
  return revision;
}
export function dropShipBound(
  quantity: bigint,
  salesOpen: bigint,
  purchaseOpen: bigint,
): void {
  if (quantity <= 0n || quantity > salesOpen || quantity > purchaseOpen)
    dropShipRefused(
      'Supplier delivery exceeds the open sales or purchase quantity',
    );
}

/** Supplier eligibility is read afresh at each admission boundary. */
export async function assertDropShipSupplier(
  client: Pick<PoolClient, 'query'>,
  storage: StorageTargetPayloadV1,
  scope: Pick<DropShipScope, 'tenantId' | 'environmentId'>,
  supplier: unknown,
): Promise<void> {
  if (
    typeof supplier !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      supplier,
    )
  )
    dropShipRefused('Drop ship requires a supplier');
  const party = dropShipEntity(storage, 'party');
  const role = dropShipEntity(storage, 'party_role');
  const ns = party.entityId.split(':entity.')[0];
  const q = dropShipQuote;
  const found = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${dropShipTable(party)} p JOIN ${dropShipTable(role)} r ON r.${q(dropShipRelation(storage, 'party_role_party'))}=p.record_id AND r.tenant_id=p.tenant_id AND r.environment_id=p.environment_id WHERE p.tenant_id=$1 AND p.environment_id=$2 AND p.record_id=$3 AND p.archived_at IS NULL AND r.archived_at IS NULL AND r.${q(dropShipColumn(role, 'party_role_kind'))}=$4 AND r.${q(dropShipColumn(role, 'party_role_status'))}=$5`,
    [
      scope.tenantId,
      scope.environmentId,
      supplier,
      `${ns}:option.supplier`,
      `${ns}:option.active`,
    ],
  );
  if (Number(found.rows[0]?.count ?? 0) < 1)
    dropShipRefused('Drop-ship supplier must be an active supplier');
}

/** Route admission happens before the unchanged stock command is constructed. */
export async function assertStockRoutes(
  client: Pick<PoolClient, 'query'>,
  storage: StorageTargetPayloadV1,
  scope: DropShipScope,
  side: 'sales' | 'purchase',
  lineIds: readonly string[],
): Promise<void> {
  if (
    !storage.entities.some((entry) =>
      entry.entityId.endsWith(':entity.drop_ship_delivery'),
    ) ||
    lineIds.length === 0
  )
    return;
  const target = dropShipEntity(storage, `${side}_order_line`);
  const route =
    side === 'sales'
      ? dropShipColumn(target, 'sales_order_line_fulfillment_route')
      : dropShipRelation(storage, 'purchase_order_line_sales_line');
  const rows = await client.query<{ route: string | null }>(
    `SELECT ${dropShipQuote(route)}::text AS route FROM ${dropShipTable(target)} WHERE tenant_id=$1 AND environment_id=$2 AND ${dropShipQuote(target.legalEntity!.column)}=$3 AND record_id=ANY($4::uuid[]) AND archived_at IS NULL`,
    [scope.tenantId, scope.environmentId, scope.legalEntityId, lineIds],
  );
  if (
    rows.rows.length !== new Set(lineIds).size ||
    rows.rows.some((row) =>
      side === 'purchase'
        ? row.route !== null
        : row.route?.endsWith(':option.fulfillment_route_drop_ship'),
    )
  )
    dropShipRefused(
      'Drop-ship lines never reserve, ship or receive warehouse stock; record a supplier delivery',
    );
}

/** A delivery changes its order revisions; the lifecycle's revision fence closes the read/write race. */
export async function assertNoDeliveredOrder(
  client: Pick<PoolClient, 'query'>,
  storage: StorageTargetPayloadV1,
  scope: DropShipScope,
  side: 'sales' | 'purchase',
  orderId: string,
): Promise<void> {
  const delivery = storage.entities.find((row) =>
    row.entityId.endsWith(':entity.drop_ship_delivery'),
  );
  if (!delivery) return;
  const found = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${dropShipTable(delivery)} WHERE tenant_id=$1 AND environment_id=$2 AND ${dropShipQuote(delivery.legalEntity!.column)}=$3 AND ${dropShipQuote(dropShipRelation(storage, `drop_ship_delivery_${side}_order`))}=$4 AND archived_at IS NULL AND ${dropShipQuote(dropShipColumn(delivery, 'drop_ship_delivery_state'))}=$5`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityId,
      orderId,
      `${delivery.entityId.split(':entity.')[0]}:option.drop_ship_delivery_state_posted`,
    ],
  );
  if (Number(found.rows[0]?.count ?? 0) > 0)
    dropShipRefused(
      'Reverse supplier deliveries before cancelling their order',
    );
}

/** Net off-ledger facts only; physical shipped/received projections are never written. */
export async function deliveredByLine(
  client: Pick<PoolClient, 'query'>,
  storage: StorageTargetPayloadV1,
  scope: DropShipScope,
  side: 'sales' | 'purchase',
  lineIds: readonly string[],
): Promise<ReadonlyMap<string, { quantity: bigint; unit: string }>> {
  const delivery = storage.entities.find((entry) =>
    entry.entityId.endsWith(':entity.drop_ship_delivery'),
  );
  if (!delivery || lineIds.length === 0) return new Map();
  const q = dropShipQuote;
  const rows = await client.query<{
    line: string;
    quantity: string;
    unit: string;
    units: number;
  }>(
    `SELECT ${q(dropShipRelation(storage, `drop_ship_delivery_${side}_line`))}::text AS line,
      sum(${q(dropShipColumn(delivery, 'drop_ship_delivery_quantity'))})::text AS quantity,
      min(${q(dropShipColumn(delivery, 'drop_ship_delivery_unit_id'))}) AS unit,
      count(DISTINCT ${q(dropShipColumn(delivery, 'drop_ship_delivery_unit_id'))})::int AS units
     FROM ${dropShipTable(delivery)} WHERE tenant_id=$1 AND environment_id=$2
      AND ${q(delivery.legalEntity!.column)}=$3 AND archived_at IS NULL
      AND ${q(dropShipColumn(delivery, 'drop_ship_delivery_state'))}=$5
      AND ${q(dropShipRelation(storage, `drop_ship_delivery_${side}_line`))}=ANY($4::uuid[])
     GROUP BY 1`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityId,
      lineIds,
      `${delivery.entityId.split(':entity.')[0]}:option.drop_ship_delivery_state_posted`,
    ],
  );
  return new Map(
    rows.rows.map((row) => {
      if (row.units !== 1 || typeof row.unit !== 'string' || !row.unit)
        dropShipRefused(
          'Supplier deliveries must use exactly one unit per line',
        );
      return [
        row.line,
        { quantity: dropShipQuantity(row.quantity), unit: row.unit },
      ];
    }),
  );
}

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { TrustedRequestContext } from '@north-star/runtime';
import {
  dropShipColumn as column,
  dropShipEntity as entity,
  dropShipRelation as relation,
  dropShipTable as table,
  dropShipQuote as q,
  type DropShipScope,
  type DropShipRow,
} from './drop-ship-support.js';
import {
  fulfillmentQuantity as quantity,
  fulfillmentError,
} from './fulfillment.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';

/** Keep admission and the existing writer on one connection. The writer still
 * owns BEGIN, stock locks, commit and rollback; disconnect aborts both it and
 * this scoped session mutex. Borrowed leases never return the locked session.
 */
export async function withSpecialOrderGate<T>(
  pool: Pool,
  scope: DropShipScope,
  run: (pool: Pool) => Promise<T>,
): Promise<T> {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        'northstar.special-order-allocation/v1',
        scope.tenantId,
        scope.environmentId,
        scope.legalEntityId,
      ]),
    )
    .digest()
    .readBigInt64BE()
    .toString();
  const client = await pool.connect();
  let destroy: Error | undefined;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    const borrowed = new Proxy(client, {
      get(target, property) {
        if (property === 'release') return () => {};
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bound = Object.assign(Object.create(pool) as Pool, {
      connect: async () => borrowed,
    });
    result = await run(bound);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      const unlocked = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
        [key],
      );
      if (unlocked.rows[0]?.unlocked !== true)
        destroy = new Error('Special-order allocation lock was lost');
    } catch (error) {
      destroy =
        error instanceof Error
          ? error
          : new Error('Allocation lock cleanup failed');
    }
    client.release(destroy);
  }
  if (failed) throw failure;
  if (destroy) throw destroy;
  return result!;
}

export function assertSpecialOrderBound(
  arrived: bigint,
  shipped: bigint,
  reserved: bigint,
  requested: bigint,
): void {
  if (arrived < shipped + reserved + requested)
    throw fulfillmentError(
      'SPECIAL_ORDER_ARRIVAL_LIMIT',
      'Special-order quantity exceeds what its linked purchase line has received',
    );
}

export async function specialOrderFacts(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  scope: DropShipScope,
  salesLineId: string,
) {
  if (
    !storage.entities.some((target) =>
      target.columns.some((field) =>
        field.canonicalFieldId.endsWith(
          ':field.sales_order_line_fulfillment_route',
        ),
      ),
    )
  )
    return null;
  const sales = entity(storage, 'sales_order_line');
  const own = await client.query<DropShipRow>(
    `SELECT * FROM ${table(sales)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(sales.legalEntity!.column)}=$3 AND record_id=$4 AND archived_at IS NULL`,
    [scope.tenantId, scope.environmentId, scope.legalEntityId, salesLineId],
  );
  const line = own.rows[0];
  if (
    !line ||
    !String(line[column(sales, 'sales_order_line_fulfillment_route')]).endsWith(
      ':option.fulfillment_route_special_order',
    )
  )
    return null;
  const purchase = entity(storage, 'purchase_order_line');
  const purchaseLineId =
    line[relation(storage, 'sales_order_line_purchase_line')];
  const linked = purchaseLineId
    ? await client.query<DropShipRow>(
        `SELECT * FROM ${table(purchase)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(purchase.legalEntity!.column)}=$3 AND record_id=$4 AND archived_at IS NULL`,
        [
          scope.tenantId,
          scope.environmentId,
          scope.legalEntityId,
          purchaseLineId,
        ],
      )
    : null;
  if (
    !linked?.rows[0] ||
    linked.rows[0][relation(storage, 'purchase_order_line_sales_line')] !==
      salesLineId ||
    linked.rows[0][column(purchase, 'purchase_order_line_item_id')] !==
      line[column(sales, 'sales_order_line_item_id')]
  )
    throw fulfillmentError(
      'SPECIAL_ORDER_SUPPLY_LINK_REQUIRED',
      'Special order requires its linked purchase line',
    );
  const sum = async (
    local: string,
    rel: string,
    field: string,
    lineId: unknown,
  ) => {
    const target = entity(storage, local);
    const result = await client.query<{ quantity: string }>(
      `SELECT coalesce(sum(${q(column(target, field))}),0)::text AS quantity FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(target.legalEntity!.column)}=$3 AND ${q(relation(storage, rel))}=$4 AND archived_at IS NULL`,
      [scope.tenantId, scope.environmentId, scope.legalEntityId, lineId],
    );
    return quantity(result.rows[0]!.quantity);
  };
  const arrived = await sum(
    'purchase_order_received',
    'purchase_order_received_order_line',
    'purchase_order_received_received_quantity',
    purchaseLineId,
  );
  const shipped = await sum(
    'sales_order_shipped',
    'sales_order_shipped_order_line',
    'sales_order_shipped_shipped_quantity',
    salesLineId,
  );
  const reservation = entity(storage, 'reservation');
  const balance = entity(storage, 'reservation_balance');
  const ns = sales.entityId.split(':entity.')[0];
  const reserved = await client.query<{ quantity: string }>(
    `SELECT coalesce(sum(b.${q(column(balance, 'reservation_balance_remaining_quantity'))}),0)::text AS quantity FROM ${table(reservation)} r JOIN ${table(balance)} b ON b.tenant_id=r.tenant_id AND b.environment_id=r.environment_id AND b.${q(balance.legalEntity!.column)}=r.${q(reservation.legalEntity!.column)} AND b.${q(relation(storage, 'reservation_balance_reservation'))}=r.record_id WHERE r.tenant_id=$1 AND r.environment_id=$2 AND r.${q(reservation.legalEntity!.column)}=$3 AND r.${q(relation(storage, 'reservation_order_line'))}=$4 AND r.archived_at IS NULL AND r.${q(column(reservation, 'reservation_state'))}=ANY($5::text[])`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityId,
      salesLineId,
      ['active', 'partially_consumed', 'consumed'].map(
        (state) => `${ns}:option.reservation_state_${state}`,
      ),
    ],
  );
  return {
    arrived,
    shipped,
    reserved: quantity(reserved.rows[0]!.quantity),
    purchaseLineId: String(purchaseLineId),
  };
}

/** Called under the allocation gate, before the unchanged posting kernel. */
export async function assertSpecialOrderPosting(
  pool: Pool,
  context: TrustedRequestContext,
  storage: StorageTargetPayloadV1,
  scope: DropShipScope,
  side: 'sales' | 'purchase',
  sourceId: string,
  lines: readonly { orderLineId: string; quantityDelta: string }[],
): Promise<void> {
  if (
    !storage.relations.some((link) =>
      link.relationId.endsWith(':relation.purchase_order_line_sales_line'),
    )
  )
    return;
  await withTrustedRequestTransaction(pool, context, (client) =>
    withModuleRuntimeRole(client, async () => {
      const source = entity(
        storage,
        side === 'sales' ? 'shipment' : 'goods_receipt',
      );
      const record = await client.query<DropShipRow>(
        `SELECT * FROM ${table(source)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(source.legalEntity!.column)}=$3 AND record_id=$4 AND archived_at IS NULL`,
        [scope.tenantId, scope.environmentId, scope.legalEntityId, sourceId],
      );
      // Committed retries remain the writer's idempotency decision.
      if (
        String(
          record.rows[0]?.[
            column(
              source,
              `${side === 'sales' ? 'shipment' : 'goods_receipt'}_state`,
            )
          ],
        ).endsWith('_state_posted')
      )
        return;
      const grouped = new Map<string, bigint>();
      for (const line of lines)
        grouped.set(
          line.orderLineId,
          (grouped.get(line.orderLineId) ?? 0n) + quantity(line.quantityDelta),
        );
      for (const [lineId, delta] of grouped) {
        let salesLineId = lineId;
        if (side === 'purchase') {
          const purchase = entity(storage, 'purchase_order_line');
          const found = await client.query<DropShipRow>(
            `SELECT * FROM ${table(purchase)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(purchase.legalEntity!.column)}=$3 AND record_id=$4 AND archived_at IS NULL`,
            [scope.tenantId, scope.environmentId, scope.legalEntityId, lineId],
          );
          salesLineId = String(
            found.rows[0]?.[
              relation(storage, 'purchase_order_line_sales_line')
            ] ?? '',
          );
          if (!salesLineId) continue;
        }
        const facts = await specialOrderFacts(
          client,
          storage,
          scope,
          salesLineId,
        );
        if (!facts) continue;
        if (side === 'sales')
          assertSpecialOrderBound(facts.arrived, facts.shipped - delta, 0n, 0n);
        else
          assertSpecialOrderBound(
            facts.arrived + delta,
            facts.shipped,
            facts.reserved,
            0n,
          );
      }
    }),
  );
}

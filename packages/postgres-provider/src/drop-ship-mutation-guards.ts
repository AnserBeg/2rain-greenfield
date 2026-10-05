import type { PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { SemanticOperationExecutionRequest } from '../../runtime/src/semantic-operation-gateway.js';
import type { parseMutationInput } from './module-runtime-interpreter.js';
import {
  assertDropShipSupplier,
  dropShipEntity as entity,
  dropShipQuote as q,
  dropShipRefused as refused,
  dropShipRelation as relation,
  dropShipTable as table,
  type DropShipEntity,
  type DropShipRow,
} from './drop-ship-support.js';

/** Application-specific admission, before the ordinary unchanged record write. */
export async function assertDropShipMutation(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  target: DropShipEntity,
  request: SemanticOperationExecutionRequest,
  input: ReturnType<typeof parseMutationInput>,
): Promise<void> {
  if (
    !storage.entities.some((row) =>
      row.entityId.endsWith(':entity.drop_ship_delivery'),
    )
  )
    return;
  const ns = target.entityId.split(':entity.')[0];
  const local = target.entityId.split(':entity.')[1];
  const effect = request.definition.effect.kind;
  const headerFieldPrefix = `${ns}:field.${local}_`;
  const protectedHeaderFields = new Set(
    target.columns
      .filter((column) => {
        if (!column.canonicalFieldId.startsWith(headerFieldPrefix))
          return false;
        const name = column.canonicalFieldId.slice(headerFieldPrefix.length);
        return (
          name === 'supplier_party_id' ||
          name === 'currency' ||
          name.startsWith('ship_to_')
        );
      })
      .map((column) => column.canonicalFieldId),
  );
  if (
    local === 'purchase_order' &&
    effect === 'updateRecordEffect' &&
    Object.keys(input.patch).some((key) => protectedHeaderFields.has(key))
  ) {
    // Serialize with link creation before deciding whether this header is frozen.
    const header = await client.query<DropShipRow>(
      `SELECT * FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 FOR NO KEY UPDATE`,
      [request.context.tenantId, request.context.environmentId, input.recordId],
    );
    const line = entity(storage, 'purchase_order_line');
    const linked = await client.query(
      `SELECT record_id FROM ${table(line)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(relation(storage, 'purchase_order_line_order'))}=$3 AND ${q(relation(storage, 'purchase_order_line_sales_line'))} IS NOT NULL AND archived_at IS NULL LIMIT 1`,
      [request.context.tenantId, request.context.environmentId, input.recordId],
    );
    if (linked.rowCount) {
      const changed = Object.entries(input.patch).some(([key, value]) => {
        if (!protectedHeaderFields.has(key)) return false;
        const physical = target.columns.find(
          (column) => column.canonicalFieldId === key,
        )?.physicalName;
        return !physical || (header.rows[0]?.[physical] ?? null) !== value;
      });
      if (changed)
        refused(
          'A linked drop-ship order keeps its supplier, currency and customer ship-to',
        );
    }
  }
  if (
    local === 'purchase_order_line' &&
    (effect === 'archiveRecordEffect' ||
      (effect === 'updateRecordEffect' &&
        Object.keys(input.patch).some((key) =>
          key.endsWith(':field.purchase_order_line_item_id'),
        )))
  ) {
    const linked = await client.query(
      `SELECT record_id FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND ${q(relation(storage, 'purchase_order_line_sales_line'))} IS NOT NULL`,
      [request.context.tenantId, request.context.environmentId, input.recordId],
    );
    if (linked.rowCount)
      refused('A linked purchase line keeps its sales demand and product');
  }
  for (const key of Object.keys(input.relations))
    if (
      key.endsWith(':relation.sales_order_line_purchase_line') ||
      key.endsWith(':relation.purchase_order_line_sales_line')
    )
      refused('Demand/supply links are created only by Create drop-ship PO');
  const validate = async (values: Record<string, unknown>) => {
    if (
      values[`${ns}:field.sales_order_line_fulfillment_route`] !==
      `${ns}:option.fulfillment_route_drop_ship`
    )
      return;
    const supplier =
      values[`${ns}:field.sales_order_line_drop_ship_supplier_id`];
    await assertDropShipSupplier(client, storage, request.context, supplier);
  };
  if (
    local === 'sales_order_line' &&
    (effect === 'createRecordEffect' || effect === 'updateRecordEffect')
  ) {
    let values: Record<string, unknown> = {};
    if (effect === 'updateRecordEffect') {
      const found = await client.query<DropShipRow>(
        `SELECT * FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 FOR NO KEY UPDATE`,
        [
          request.context.tenantId,
          request.context.environmentId,
          input.recordId,
        ],
      );
      if (found.rows[0])
        values = Object.fromEntries(
          target.columns.map((col) => [
            col.canonicalFieldId,
            found.rows[0]![col.physicalName],
          ]),
        );
    }
    await validate({ ...values, ...input.patch });
  }
  if (
    local === 'sales_order' &&
    request.definition.operationId.endsWith(':operation.sales_order_release')
  ) {
    await client.query(
      `SELECT record_id FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 FOR NO KEY UPDATE`,
      [request.context.tenantId, request.context.environmentId, input.recordId],
    );
    const line = entity(storage, 'sales_order_line');
    const rows = await client.query<DropShipRow>(
      `SELECT * FROM ${table(line)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(relation(storage, 'sales_order_line_order'))}=$3 AND archived_at IS NULL ORDER BY record_id`,
      [request.context.tenantId, request.context.environmentId, input.recordId],
    );
    for (const row of rows.rows)
      await validate(
        Object.fromEntries(
          line.columns.map((col) => [
            col.canonicalFieldId,
            row[col.physicalName],
          ]),
        ),
      );
  }
}

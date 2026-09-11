import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { TrustedRequestContext } from '@north-star/runtime';
import { InventoryPostingError } from './inventory-posting-error.js';
import type { InventoryAdjustmentPostingCommandV1 } from './inventory-posting-service.js';

export const FULFILLMENT_CAPABILITY_ID =
  'northstar.sales:capability.fulfillment' as const;
export const FULFILLMENT_CAPABILITY_VERSION = 1 as const;

export interface ShipmentLineCommand {
  readonly shipmentLineId: string;
  readonly orderLineId: string;
  readonly reservationId: string;
  readonly sourceLine: string;
  readonly itemId: string;
  readonly unitId: string;
  readonly quantityDelta: string;
  readonly reversalOfMovementId: string | null;
}

export interface ShipmentCommand extends Omit<
  InventoryAdjustmentPostingCommandV1,
  'transactionId' | 'sourceType' | 'lines'
> {
  readonly sourceType: 'shipment';
  readonly kind: 'initial' | 'correction' | 'reversal';
  readonly shipmentNumber: string;
  readonly orderId: string;
  readonly locationId: string;
  readonly supersedesShipmentId: string | null;
  readonly lines: readonly ShipmentLineCommand[];
}

export interface DerivedShipmentCommand extends Omit<ShipmentCommand, 'lines'> {
  readonly transactionId: string;
  readonly lines: readonly (ShipmentLineCommand & {
    readonly transactionLineId: string;
  })[];
}

type Entity = StorageTargetPayloadV1['entities'][number];
export interface FulfillmentBinding {
  readonly target: StorageTargetPayloadV1;
  readonly reservation: Entity;
  readonly reservationBalance: Entity;
  readonly shipment: Entity;
  readonly shipmentLine: Entity;
  readonly order: Entity;
  readonly orderLine: Entity;
  readonly shipped: Entity;
  readonly movement: Entity;
  readonly balance: Entity;
  readonly item: Entity;
  readonly location: Entity;
  readonly party: Entity;
  readonly partyRole: Entity;
}

export function fulfillmentBinding(
  target: StorageTargetPayloadV1,
): FulfillmentBinding | null {
  const entity = (local: string): Entity => {
    const matches = target.entities.filter((entry) =>
      entry.entityId.endsWith(`:entity.${local}`),
    );
    if (matches.length !== 1)
      throw fulfillmentError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        `Expected one ${local} entity`,
      );
    return matches[0]!;
  };
  if (
    !target.entities.some((entry) =>
      entry.entityId.endsWith(':entity.shipment'),
    )
  )
    return null;
  return {
    target,
    reservation: entity('reservation'),
    reservationBalance: entity('reservation_balance'),
    shipment: entity('shipment'),
    shipmentLine: entity('shipment_line'),
    order: entity('sales_order'),
    orderLine: entity('sales_order_line'),
    shipped: entity('sales_order_shipped'),
    movement: entity('inventory_movement'),
    balance: entity('posted_stock_balance'),
    item: entity('item'),
    location: entity('location'),
    party: entity('party'),
    partyRole: entity('party_role'),
  };
}

export const fulfillmentTable = (entity: Entity): string =>
  `north_star_module.${quoteFulfillmentIdentifier(entity.physicalTableName)}`;

export function quoteFulfillmentIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error('Invalid storage identifier');
  return `"${value}"`;
}

export function fulfillmentColumn(entity: Entity, suffix: string): string {
  const found = entity.columns.filter(
    (entry) =>
      entry.canonicalFieldId.endsWith(`:field.${suffix}`) ||
      entry.canonicalFieldId.endsWith(`:${suffix}`),
  );
  if (found.length !== 1)
    throw fulfillmentError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing field ${suffix}`,
    );
  return found[0]!.physicalName;
}

export function fulfillmentRelation(
  binding: FulfillmentBinding,
  entity: Entity,
  suffix: string,
): string {
  const relation = binding.target.relations.find((entry) =>
    entry.relationId.endsWith(`:relation.${suffix}`),
  );
  if (!relation || relation.sourceEntityId !== entity.entityId)
    throw fulfillmentError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing relation ${suffix}`,
    );
  return relation.relationColumn.physicalName;
}

export function fulfillmentOption(
  entity: Entity,
  suffix: string,
  option: string,
): string {
  const column = entity.columns.find((entry) =>
    entry.canonicalFieldId.endsWith(`:field.${suffix}`),
  );
  const found = column?.fieldContract.enumOptionIds.find(
    (entry) => entry.endsWith(`_${option}`) || entry.endsWith(`.${option}`),
  );
  if (!found)
    throw fulfillmentError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing option ${suffix}/${option}`,
    );
  return found;
}

export function fulfillmentError(
  code: ConstructorParameters<typeof InventoryPostingError>[0],
  message: string,
  details: Record<string, string> = {},
): InventoryPostingError {
  return new InventoryPostingError(code, message, details);
}

const scale = 10n ** 18n;
export function fulfillmentQuantity(value: string): bigint {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/u.test(value))
    throw fulfillmentError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Quantity must be an exact decimal with at most 18 fractional digits',
    );
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const result =
    (BigInt(whole!) * scale + BigInt(fraction.padEnd(18, '0'))) *
    (value.startsWith('-') ? -1n : 1n);
  if (result <= -(10n ** 38n) || result >= 10n ** 38n)
    throw fulfillmentError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Quantity exceeds precision',
    );
  return result;
}

export function fulfillmentDecimal(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % scale)
    .toString()
    .padStart(18, '0')
    .replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${magnitude / scale}${fraction ? `.${fraction}` : ''}`;
}

export function fulfillmentProjectionIdentity(
  context: Pick<TrustedRequestContext, 'tenantId' | 'environmentId'>,
  legalEntityId: string,
  family: 'shipped' | 'reservation',
  sourceId: string,
): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'northstar.fulfillment-projection/v1',
        context.tenantId,
        context.environmentId,
        legalEntityId,
        family,
        sourceId,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export type FulfillmentRow = Record<string, unknown>;
export async function fulfillmentRow(
  client: PoolClient,
  entity: Entity,
  context: TrustedRequestContext,
  legalEntityId: string,
  id: string,
  lock = false,
): Promise<FulfillmentRow> {
  const result = await client.query(
    `SELECT row.*, (SELECT relname FROM pg_class WHERE oid=row.tableoid) AS "__relation"
       FROM ${fulfillmentTable(entity)} row
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoteFulfillmentIdentifier(entity.legalEntity!.column)}=$3
        AND record_id=$4
      ${lock ? 'FOR NO KEY UPDATE OF row' : ''}`,
    [context.tenantId, context.environmentId, legalEntityId, id],
  );
  if (result.rows.length !== 1)
    throw fulfillmentError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Record is absent from the requested entity and scope',
      { recordId: id },
    );
  return result.rows[0] as FulfillmentRow;
}

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { TrustedRequestContext } from '@north-star/runtime';
import { InventoryPostingError } from './inventory-posting-error.js';
import type { InventoryAdjustmentPostingCommandV1 } from './inventory-posting-service.js';

export const RECEIVING_CAPABILITY_ID =
  'northstar.purchasing:capability.receiving' as const;
export const RECEIVING_CAPABILITY_VERSION = 1 as const;
export interface GoodsReceiptLine {
  readonly receiptLineId: string;
  readonly orderLineId: string;
  readonly sourceLine: string;
  readonly itemId: string;
  readonly unitId: string;
  readonly quantityDelta: string;
  readonly costStatus: 'known' | 'absent';
  readonly unitCost: string | null;
  readonly currency: string | null;
  readonly reversalOfMovementId: string | null;
}
export interface GoodsReceiptCommand extends Omit<
  InventoryAdjustmentPostingCommandV1,
  'transactionId' | 'sourceType' | 'lines'
> {
  readonly sourceType: 'goodsReceipt';
  readonly kind: 'initial' | 'correction' | 'reversal';
  readonly receiptNumber: string;
  readonly orderId: string;
  readonly locationId: string;
  readonly supersedesReceiptId: string | null;
  readonly lines: readonly GoodsReceiptLine[];
}
export interface DerivedGoodsReceiptCommand extends Omit<
  GoodsReceiptCommand,
  'lines'
> {
  readonly transactionId: string;
  readonly lines: readonly (GoodsReceiptLine & {
    readonly transactionLineId: string;
  })[];
}

type Entity = StorageTargetPayloadV1['entities'][number];
export interface ReceiptBinding {
  readonly target: StorageTargetPayloadV1;
  readonly receipt: Entity;
  readonly line: Entity;
  readonly order: Entity;
  readonly orderLine: Entity;
  readonly received: Entity;
  readonly movement: Entity;
}
export function receiptBinding(
  target: StorageTargetPayloadV1,
): ReceiptBinding | null {
  const entity = (local: string) => {
    const matches = target.entities.filter((entry) =>
      entry.entityId.endsWith(`:entity.${local}`),
    );
    if (matches.length !== 1)
      throw receiptError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        `Expected one ${local} entity`,
      );
    return matches[0]!;
  };
  if (
    !target.entities.some((entry) =>
      entry.entityId.endsWith(':entity.goods_receipt'),
    )
  )
    return null;
  return {
    target,
    receipt: entity('goods_receipt'),
    line: entity('goods_receipt_line'),
    order: entity('purchase_order'),
    orderLine: entity('purchase_order_line'),
    received: entity('purchase_order_received'),
    movement: entity('inventory_movement'),
  };
}
export const receiptTable = (entity: Entity): string =>
  `north_star_module.${quoteReceiptIdentifier(entity.physicalTableName)}`;
export function quoteReceiptIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error('Invalid storage identifier');
  return `"${value}"`;
}
export function receiptColumn(entity: Entity, suffix: string): string {
  const found = entity.columns.filter(
    (entry) =>
      entry.canonicalFieldId.endsWith(`:field.${suffix}`) ||
      entry.canonicalFieldId.endsWith(`:${suffix}`),
  );
  if (found.length !== 1)
    throw receiptError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing field ${suffix}`,
    );
  return found[0]!.physicalName;
}
export function receiptRelation(
  binding: ReceiptBinding,
  entity: Entity,
  suffix: string,
): string {
  const relation = binding.target.relations.find((entry) =>
    entry.relationId.endsWith(`:relation.${suffix}`),
  );
  if (!relation)
    throw receiptError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing relation ${suffix}`,
    );
  if (relation.sourceEntityId !== entity.entityId)
    throw receiptError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'Relation source differs',
    );
  return relation.relationColumn.physicalName;
}
export function receiptOption(
  entity: Entity,
  suffix: string,
  option: string,
): string {
  const column = entity.columns.find((entry) =>
    entry.canonicalFieldId.endsWith(`:field.${suffix}`),
  );
  const found = column?.fieldContract.enumOptionIds.find((entry) =>
    entry.endsWith(`_${option}`),
  );
  if (!found)
    throw receiptError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing option ${suffix}/${option}`,
    );
  return found;
}
export function receiptError(
  code: ConstructorParameters<typeof InventoryPostingError>[0],
  message: string,
  details: Record<string, string> = {},
): InventoryPostingError {
  return new InventoryPostingError(code, message, details);
}
const scale = 10n ** 18n;
export function receiptQuantity(value: string): bigint {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/u.test(value))
    throw receiptError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Quantity must be exact decimal',
    );
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const result =
    (BigInt(whole!) * scale + BigInt(fraction.padEnd(18, '0'))) *
    (value.startsWith('-') ? -1n : 1n);
  if (result <= -(10n ** 38n) || result >= 10n ** 38n)
    throw receiptError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Quantity exceeds precision',
    );
  return result;
}
export function receiptDecimal(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % scale)
    .toString()
    .padStart(18, '0')
    .replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${magnitude / scale}${fraction ? `.${fraction}` : ''}`;
}
export function receivedIdentity(
  context: Pick<TrustedRequestContext, 'tenantId' | 'environmentId'>,
  legalEntityId: string,
  orderLineId: string,
): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'northstar.received-quantity/v1',
        context.tenantId,
        context.environmentId,
        legalEntityId,
        orderLineId,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
export type ReceiptRow = Record<string, unknown>;
export async function receiptRow(
  client: PoolClient,
  entity: Entity,
  context: TrustedRequestContext,
  legalEntityId: string,
  id: string,
  lock = false,
): Promise<ReceiptRow> {
  const result = await client.query(
    `SELECT row.*, (SELECT relname FROM pg_class WHERE oid = row.tableoid) AS "__relation"
    FROM ${receiptTable(entity)} row WHERE tenant_id=$1 AND environment_id=$2 AND ${quoteReceiptIdentifier(entity.legalEntity!.column)}=$3 AND record_id=$4
    ${lock ? 'FOR NO KEY UPDATE OF row' : ''}`,
    [context.tenantId, context.environmentId, legalEntityId, id],
  );
  if (result.rows.length !== 1)
    throw receiptError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Record is absent from the requested entity',
      { recordId: id },
    );
  return result.rows[0] as ReceiptRow;
}
export interface LockedReceipt {
  readonly header: ReceiptRow;
  readonly lines: readonly ReceiptRow[];
  readonly orderLines: ReadonlyMap<string, ReceiptRow>;
  readonly priorProgress: ReadonlyMap<string, ReceiptRow | null>;
}
export async function lockReceipt(
  client: PoolClient,
  binding: ReceiptBinding,
  context: TrustedRequestContext,
  command: DerivedGoodsReceiptCommand,
): Promise<LockedReceipt> {
  // Every receiving/lifecycle/amendment writer takes order, then order lines,
  // then receipt rows. Stock and request-key locks precede this entire phase.
  const order = await receiptRow(
    client,
    binding.order,
    context,
    command.legalEntityId,
    command.orderId,
    true,
  );
  const state = receiptColumn(
    binding.order,
    'derived_state_field.machine.purchase_order_lifecycle',
  );
  if (
    order.archived_at !== null ||
    !String(order[state]).endsWith(':state.purchase_order_released')
  )
    throw receiptError(
      'RECEIPT_ORDER_NOT_RELEASED',
      'Reopen a closed order before receiving or correcting it',
    );
  const orderLines = new Map<string, ReceiptRow>();
  const priorProgress = new Map<string, ReceiptRow | null>();
  for (const id of [
    ...new Set(command.lines.map((line) => line.orderLineId)),
  ].sort()) {
    const row = await receiptRow(
      client,
      binding.orderLine,
      context,
      command.legalEntityId,
      id,
      true,
    );
    if (
      row.archived_at !== null ||
      row[
        receiptRelation(binding, binding.orderLine, 'purchase_order_line_order')
      ] !== command.orderId
    )
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receipt line does not belong to the order',
      );
    orderLines.set(id, row);
    const prior = await client.query(
      `SELECT * FROM ${receiptTable(binding.received)} WHERE tenant_id=$1 AND environment_id=$2 AND ${quoteReceiptIdentifier(binding.received.legalEntity!.column)}=$3 AND record_id=$4`,
      [
        context.tenantId,
        context.environmentId,
        command.legalEntityId,
        receivedIdentity(context, command.legalEntityId, id),
      ],
    );
    priorProgress.set(id, (prior.rows[0] as ReceiptRow | undefined) ?? null);
  }
  const header = await receiptRow(
    client,
    binding.receipt,
    context,
    command.legalEntityId,
    command.sourceId,
    true,
  );
  const linesResult = await client.query(
    `SELECT line.* FROM ${receiptTable(binding.line)} line
    WHERE tenant_id=$1 AND environment_id=$2 AND ${quoteReceiptIdentifier(binding.line.legalEntity!.column)}=$3
      AND ${quoteReceiptIdentifier(receiptRelation(binding, binding.line, 'goods_receipt_line_receipt'))}=$4 AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.sourceId,
    ],
  );
  const lines = linesResult.rows as ReceiptRow[];
  const postedReplay =
    header[receiptColumn(binding.receipt, 'goods_receipt_state')] ===
      receiptOption(binding.receipt, 'goods_receipt_state', 'posted') &&
    Number(header.revision) === command.sourceRevision + 1;
  if (
    header.archived_at !== null ||
    (!postedReplay && Number(header.revision) !== command.sourceRevision) ||
    lines.length !== command.lines.length
  )
    throw receiptError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      'Receipt revision or line set changed',
    );
  const headerExpected = [
    ['number', command.receiptNumber],
    [
      'kind',
      receiptOption(binding.receipt, 'goods_receipt_kind', command.kind),
    ],
    ['location_id', command.locationId],
    ['reason_code', command.reason.code],
    ['reason_narrative', command.reason.narrative],
  ] as const;
  for (const [name, value] of headerExpected)
    if (
      header[receiptColumn(binding.receipt, `goods_receipt_${name}`)] !== value
    )
      throw receiptError(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        `Receipt ${name} changed`,
      );
  const instant =
    header[receiptColumn(binding.receipt, 'goods_receipt_effective_at')];
  if (
    (instant instanceof Date
      ? instant
      : new Date(String(instant))
    ).toISOString() !== command.effectiveAt ||
    header[receiptRelation(binding, binding.receipt, 'goods_receipt_order')] !==
      command.orderId ||
    header[
      receiptRelation(binding, binding.receipt, 'goods_receipt_supersedes')
    ] !== command.supersedesReceiptId
  )
    throw receiptError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      'Receipt attribution or date changed',
    );
  for (const line of command.lines) {
    const stored = lines.find((row) => row.record_id === line.receiptLineId);
    const orderLine = orderLines.get(line.orderLineId)!;
    if (
      !stored ||
      stored[
        receiptRelation(binding, binding.line, 'goods_receipt_line_order_line')
      ] !== line.orderLineId ||
      orderLine[
        receiptColumn(binding.orderLine, 'purchase_order_line_item_id')
      ] !== line.itemId
    )
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receipt item or order-line attribution differs',
      );
    for (const [name, value] of [
      ['item_id', line.itemId],
      ['unit_id', line.unitId],
      ['currency', line.currency],
      ['reversal_of_movement_id', line.reversalOfMovementId],
      [
        'cost_status',
        receiptOption(
          binding.line,
          'goods_receipt_line_cost_status',
          line.costStatus,
        ),
      ],
    ] as const) {
      if (
        stored[receiptColumn(binding.line, `goods_receipt_line_${name}`)] !==
        value
      )
        throw receiptError(
          'INVENTORY_TRANSACTION_STATE_CONFLICT',
          `Receipt line ${name} changed`,
        );
    }
    if (
      String(
        stored[receiptColumn(binding.line, 'goods_receipt_line_line_number')],
      ) !== line.sourceLine ||
      receiptQuantity(
        String(
          stored[receiptColumn(binding.line, 'goods_receipt_line_quantity')],
        ),
      ) !== receiptQuantity(line.quantityDelta)
    )
      throw receiptError(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        'Receipt quantity changed',
      );
    const cost =
      stored[receiptColumn(binding.line, 'goods_receipt_line_unit_cost')];
    if (
      line.costStatus === 'absent'
        ? cost !== null || line.unitCost !== null || line.currency !== null
        : line.unitCost === null ||
          cost === null ||
          receiptQuantity(String(cost)) !== receiptQuantity(line.unitCost) ||
          receiptQuantity(line.unitCost) < 0n ||
          !/^[A-Z]{3}$/u.test(line.currency ?? '')
    )
      throw receiptError(
        'RECEIPT_COST_REQUIRED',
        'Enter actual received unit cost and currency, or explicitly mark cost absent',
      );
  }
  return { header, lines, orderLines, priorProgress };
}

export async function receivedLedger(
  client: PoolClient,
  binding: ReceiptBinding,
  context: Pick<TrustedRequestContext, 'tenantId' | 'environmentId'>,
  legalEntityId: string,
  orderLineId: string,
): Promise<{ quantity: string; unit: string | null; count: number }> {
  const m = binding.movement,
    l = binding.line;
  const result = await client.query<{
    quantity: string;
    unit: string | null;
    count: string;
    units: string;
  }>(
    `SELECT coalesce(sum(m.${quoteReceiptIdentifier(receiptColumn(m, 'inventory_movement_quantity_delta'))}),0)::text AS quantity,
      min(m.${quoteReceiptIdentifier(receiptColumn(m, 'inventory_movement_unit_id'))}) AS unit, count(*)::text AS count,
      count(DISTINCT m.${quoteReceiptIdentifier(receiptColumn(m, 'inventory_movement_unit_id'))})::text AS units
    FROM ${receiptTable(m)} m JOIN ${receiptTable(l)} l ON l.tenant_id=m.tenant_id AND l.environment_id=m.environment_id
      AND l.${quoteReceiptIdentifier(l.legalEntity!.column)}=m.${quoteReceiptIdentifier(m.legalEntity!.column)}
      AND l.record_id::text=m.${quoteReceiptIdentifier(receiptColumn(m, 'inventory_movement_source_line'))}
      AND l.${quoteReceiptIdentifier(receiptRelation(binding, l, 'goods_receipt_line_receipt'))}::text=m.${quoteReceiptIdentifier(receiptColumn(m, 'inventory_movement_source_id'))}
    WHERE m.tenant_id=$1 AND m.environment_id=$2 AND m.${quoteReceiptIdentifier(m.legalEntity!.column)}=$3
      AND l.${quoteReceiptIdentifier(receiptRelation(binding, l, 'goods_receipt_line_order_line'))}=$4
      AND m.${quoteReceiptIdentifier(receiptColumn(m, 'inventory_movement_source_type'))}='goodsReceipt' AND m.archived_at IS NULL`,
    [context.tenantId, context.environmentId, legalEntityId, orderLineId],
  );
  const row = result.rows[0]!;
  if (Number(row.units) > 1)
    throw receiptError(
      'RECEIPT_PROJECTION_DIVERGED',
      'Order-line ledger contains multiple base units',
    );
  return {
    quantity: receiptDecimal(receiptQuantity(row.quantity)),
    unit: row.unit,
    count: Number(row.count),
  };
}

export async function assertReceiptBounds(
  client: PoolClient,
  binding: ReceiptBinding,
  context: TrustedRequestContext,
  command: DerivedGoodsReceiptCommand,
  locked: LockedReceipt,
): Promise<void> {
  if (
    locked.header[receiptColumn(binding.receipt, 'goods_receipt_state')] !==
    receiptOption(binding.receipt, 'goods_receipt_state', 'draft')
  )
    throw receiptError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      'Receipt is already posted',
    );
  for (const [id, row] of locked.orderLines) {
    const ledger = await receivedLedger(
      client,
      binding,
      context,
      command.legalEntityId,
      id,
    );
    const attempted = command.lines
      .filter((line) => line.orderLineId === id)
      .reduce((sum, line) => sum + receiptQuantity(line.quantityDelta), 0n);
    const ordered = receiptQuantity(
      String(
        row[
          receiptColumn(
            binding.orderLine,
            'purchase_order_line_ordered_quantity',
          )
        ],
      ),
    );
    const result = receiptQuantity(ledger.quantity) + attempted;
    if (result < 0n || result > ordered)
      throw receiptError(
        'RECEIPT_QUANTITY_OUT_OF_BOUNDS',
        'Receipt quantity must keep received between zero and ordered',
        {
          orderLineId: id,
          orderedQuantity: receiptDecimal(ordered),
          receivedBefore: ledger.quantity,
          attemptedQuantity: receiptDecimal(attempted),
        },
      );
  }
}

export async function writeReceivedProjection(
  client: PoolClient,
  binding: ReceiptBinding,
  context: TrustedRequestContext,
  command: DerivedGoodsReceiptCommand,
): Promise<void> {
  const entity = binding.received;
  for (const id of [
    ...new Set(command.lines.map((line) => line.orderLineId)),
  ].sort()) {
    const ledger = await receivedLedger(
      client,
      binding,
      context,
      command.legalEntityId,
      id,
    );
    await client.query(
      `INSERT INTO ${receiptTable(entity)} AS progress (tenant_id,environment_id,${quoteReceiptIdentifier(entity.legalEntity!.column)},record_id,revision,archived_at,
      ${quoteReceiptIdentifier(receiptRelation(binding, entity, 'purchase_order_received_order_line'))},${quoteReceiptIdentifier(receiptColumn(entity, 'purchase_order_received_received_quantity'))},${quoteReceiptIdentifier(receiptColumn(entity, 'purchase_order_received_unit_id'))})
      VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7) ON CONFLICT (tenant_id,environment_id,${quoteReceiptIdentifier(entity.legalEntity!.column)},record_id)
      DO UPDATE SET revision=progress.revision+1,archived_at=NULL,${quoteReceiptIdentifier(receiptColumn(entity, 'purchase_order_received_received_quantity'))}=EXCLUDED.${quoteReceiptIdentifier(receiptColumn(entity, 'purchase_order_received_received_quantity'))},${quoteReceiptIdentifier(receiptColumn(entity, 'purchase_order_received_unit_id'))}=EXCLUDED.${quoteReceiptIdentifier(receiptColumn(entity, 'purchase_order_received_unit_id'))}`,
      [
        context.tenantId,
        context.environmentId,
        command.legalEntityId,
        receivedIdentity(context, command.legalEntityId, id),
        id,
        ledger.quantity,
        ledger.unit,
      ],
    );
  }
}

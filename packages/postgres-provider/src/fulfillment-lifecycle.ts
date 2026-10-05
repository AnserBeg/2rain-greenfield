import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationExecutionRequest,
  type SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type { PostgresCapabilityOperationExecutorContext } from './capability-operation-executor-factory.js';
import {
  fulfillmentColumn,
  fulfillmentDecimal,
  fulfillmentError,
  fulfillmentOption,
  fulfillmentProjectionIdentity,
  fulfillmentQuantity,
  fulfillmentRelation,
  fulfillmentRow,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
  type FulfillmentBinding,
  type FulfillmentRow,
} from './fulfillment.js';
import { acquireStockIdentityLocks } from './stock-serializer.js';
import {
  auditFieldId,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import {
  withSpecialOrderGate,
  specialOrderFacts,
  assertSpecialOrderBound,
} from './special-order-support.js';

export interface PreparedFulfillmentTarget {
  readonly legalEntityId: string;
  readonly currentRevision: number;
  readonly recordId: string;
  readonly expectedRevision: number;
  readonly itemId: string | null;
  readonly locationId: string | null;
}

interface TransitionResult {
  readonly recordId: string;
  readonly legalEntityId: string;
  readonly revision: number;
  readonly before: string;
  readonly after: string;
  readonly releasedReservationIds: readonly string[];
}

export async function executeFulfillmentLifecycle(
  context: PostgresCapabilityOperationExecutorContext,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  prepared: PreparedFulfillmentTarget,
  action: 'reserve' | 'release' | 'close' | 'cancel',
): Promise<SemanticOperationResultEnvelope> {
  const entity =
    action === 'reserve' || action === 'release'
      ? binding.reservation
      : binding.order;
  const input = request.input as Record<string, unknown>;
  if (
    request.readBackDefinition.sourceEntityId !== entity.entityId ||
    typeof input.recordId !== 'string' ||
    typeof input.expectedRevision !== 'number'
  )
    throw fulfillmentError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Fulfillment transition requires its record and exact revision',
    );

  const actor = await context.actorIssuer.issue(request.context);
  const trust = await withSpecialOrderGate(
    context.pool,
    { ...request.context, legalEntityId: prepared.legalEntityId },
    (pool) =>
      new PostgresTrustService(pool).executeIdempotentAcceptedMutation<{
        recordId: string;
        legalEntityId: string;
        revision: number;
      }>(
        request.context,
        actor,
        {
          actionId: request.definition.operationId,
          idempotencyKey: request.idempotencyKey,
          inputDigest: request.inputDigest,
          releaseContentHash: request.view.release.contentHash,
          releaseId: request.view.release.releaseId,
        },
        (client) =>
          withModuleRuntimeRole(client, async () => {
            const changed =
              action === 'reserve'
                ? await reserve(client, binding, request, prepared)
                : action === 'release'
                  ? await release(client, binding, request, prepared)
                  : await changeOrder(
                      client,
                      binding,
                      request,
                      prepared,
                      action,
                    );
            const metadata = {
              legalEntityId: {
                classification: 'INTERNAL' as const,
                value: changed.legalEntityId,
              },
              operationId: {
                classification: 'INTERNAL' as const,
                value: request.definition.operationId,
              },
              ...(changed.releasedReservationIds.length
                ? {
                    releasedReservationIds: {
                      classification: 'INTERNAL' as const,
                      value: [...changed.releasedReservationIds],
                    },
                  }
                : {}),
            };
            return {
              mutationResult: {
                recordId: changed.recordId,
                legalEntityId: changed.legalEntityId,
                revision: changed.revision,
              },
              command: {
                actionId: request.definition.operationId,
                causationId: null,
                channel: request.channel,
                correlationId: randomUUID(),
                invocationId: randomUUID(),
                metadata,
                releaseContentHash: request.view.release.contentHash,
                releaseId: request.view.release.releaseId,
                policy: {
                  decision: 'ALLOW' as const,
                  evaluatorVersion: request.policyEvaluatorVersion,
                  policyVersion: request.policyVersion,
                  relevantInputs: metadata,
                  schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
                },
                change: {
                  changeDocumentId: randomUUID(),
                  recordId: changed.recordId,
                  recordType: entity.entityId,
                  revision: changed.revision,
                  changes: [
                    {
                      classification: 'INTERNAL' as const,
                      fieldId: auditFieldId(
                        action === 'reserve' || action === 'release'
                          ? `${entity.entityId}.state`
                          : `${entity.entityId}.lifecycle`,
                      ),
                      oldState: {
                        state: 'VALUE' as const,
                        value: changed.before,
                      },
                      newState: {
                        state: 'VALUE' as const,
                        value: changed.after,
                      },
                    },
                    ...(changed.releasedReservationIds.length
                      ? [
                          {
                            classification: 'INTERNAL' as const,
                            fieldId: auditFieldId('releasedReservationIds'),
                            oldState: {
                              state: 'VALUE' as const,
                              value: [] as string[],
                            },
                            newState: {
                              state: 'VALUE' as const,
                              value: [...changed.releasedReservationIds],
                            },
                          },
                        ]
                      : []),
                  ],
                },
                event: {
                  eventId: randomUUID(),
                  eventSchemaVersion: 'northstar.fulfillment-event/v1',
                  eventType: request.definition.operationId.replace(
                    ':operation.',
                    ':event.',
                  ),
                  payload: metadata,
                },
                outbox: {
                  outboxId: randomUUID(),
                  deduplicationKey: `${request.definition.operationId}:${request.context.principalId}:${request.idempotencyKey}`,
                },
              },
            };
          }),
        prepared.itemId && prepared.locationId
          ? async (client) => {
              await acquireStockIdentityLocks(client, [
                {
                  tenantId: request.context.tenantId,
                  environmentId: request.context.environmentId,
                  legalEntityId: prepared.legalEntityId,
                  itemId: prepared.itemId!,
                  locationId: prepared.locationId!,
                },
              ]);
            }
          : undefined,
      ),
  );
  return fulfillmentReadBack(context, request, trust);
}

async function reserve(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  prepared: PreparedFulfillmentTarget,
): Promise<TransitionResult> {
  // Relation identities are read without locks only to discover the lock set.
  // After the canonical stock identity lock held by the trust service, every
  // fulfillment path takes business locks in parent-to-child order. The rows
  // are then re-read under lock and the discovery snapshot is rejected if it
  // changed, so this avoids an order-cancellation/reservation deadlock without
  // trusting the unlocked values.
  const candidateReservation = await fulfillmentRow(
    client,
    binding.reservation,
    request.context,
    prepared.legalEntityId,
    prepared.recordId,
  );
  const lineId = String(
    candidateReservation[
      fulfillmentRelation(
        binding,
        binding.reservation,
        'reservation_order_line',
      )
    ],
  );
  const candidateLine = await fulfillmentRow(
    client,
    binding.orderLine,
    request.context,
    prepared.legalEntityId,
    lineId,
  );
  const orderId = String(
    candidateLine[
      fulfillmentRelation(binding, binding.orderLine, 'sales_order_line_order')
    ],
  );
  const order = await fulfillmentRow(
    client,
    binding.order,
    request.context,
    prepared.legalEntityId,
    orderId,
    true,
  );
  const line = await fulfillmentRow(
    client,
    binding.orderLine,
    request.context,
    prepared.legalEntityId,
    lineId,
    true,
  );
  const reservation = await fulfillmentRow(
    client,
    binding.reservation,
    request.context,
    prepared.legalEntityId,
    prepared.recordId,
    true,
  );
  if (
    candidateReservation.revision !== reservation.revision ||
    candidateLine.revision !== line.revision ||
    reservation[
      fulfillmentRelation(
        binding,
        binding.reservation,
        'reservation_order_line',
      )
    ] !== lineId ||
    line[
      fulfillmentRelation(binding, binding.orderLine, 'sales_order_line_order')
    ] !== orderId
  )
    throw fulfillmentError(
      'FULFILLMENT_RESERVATION_STATE_CONFLICT',
      'Reservation attribution changed while canonical locks were acquired',
    );
  assertCurrent(reservation, prepared);
  assertReleasedOrder(binding, order);
  await assertActiveCustomer(client, binding, request, order);

  const before = String(
    reservation[fulfillmentColumn(binding.reservation, 'reservation_state')],
  );
  const draft = fulfillmentOption(
    binding.reservation,
    'reservation_state',
    'draft',
  );
  if (before !== draft || reservation.archived_at !== null)
    throw fulfillmentError(
      'FULFILLMENT_RESERVATION_STATE_CONFLICT',
      'Only a current draft reservation can be reserved',
    );
  const itemId = String(
    reservation[fulfillmentColumn(binding.reservation, 'reservation_item_id')],
  );
  const locationId = String(
    reservation[
      fulfillmentColumn(binding.reservation, 'reservation_location_id')
    ],
  );
  const unitId = String(
    reservation[fulfillmentColumn(binding.reservation, 'reservation_unit_id')],
  );
  const quantity = fulfillmentQuantity(
    String(
      reservation[
        fulfillmentColumn(binding.reservation, 'reservation_quantity')
      ],
    ),
  );
  if (
    quantity <= 0n ||
    itemId !==
      line[fulfillmentColumn(binding.orderLine, 'sales_order_line_item_id')] ||
    unitId !==
      line[fulfillmentColumn(binding.orderLine, 'sales_order_line_unit_id')] ||
    itemId !== prepared.itemId ||
    locationId !== prepared.locationId
  )
    throw fulfillmentError(
      'FULFILLMENT_QUANTITY_OUT_OF_BOUNDS',
      'Reservation item, base unit, quantity, or locked stock identity differs from its order line',
    );
  await assertItemLocation(
    client,
    binding,
    request,
    itemId,
    locationId,
    unitId,
  );
  const onHand = await onHandQuantity(
    client,
    binding,
    request,
    prepared.legalEntityId,
    itemId,
    locationId,
  );
  const identityReserved = await reservedQuantity(
    client,
    binding,
    request,
    prepared.legalEntityId,
    { itemId, locationId },
  );
  const lineReserved = await reservedQuantity(
    client,
    binding,
    request,
    prepared.legalEntityId,
    { orderLineId: lineId },
  );
  const shipped = await shippedQuantity(
    client,
    binding,
    request,
    prepared.legalEntityId,
    lineId,
  );
  const ordered = fulfillmentQuantity(
    String(
      line[
        fulfillmentColumn(
          binding.orderLine,
          'sales_order_line_ordered_quantity',
        )
      ],
    ),
  );
  const supply = await specialOrderFacts(
    client,
    binding.target,
    { ...request.context, legalEntityId: prepared.legalEntityId },
    lineId,
  );
  if (supply)
    assertSpecialOrderBound(supply.arrived, shipped, lineReserved, quantity);
  if (onHand - identityReserved < quantity)
    throw fulfillmentError(
      'FULFILLMENT_RESERVATION_SHORTAGE',
      'The requested quantity is not fully available at this location',
      {
        available: fulfillmentDecimal(onHand - identityReserved),
        requested: fulfillmentDecimal(quantity),
      },
    );
  if (ordered - shipped - lineReserved < quantity)
    throw fulfillmentError(
      'FULFILLMENT_QUANTITY_OUT_OF_BOUNDS',
      'The requested quantity exceeds the order line open-to-ship quantity across locations',
      {
        openToReserve: fulfillmentDecimal(ordered - shipped - lineReserved),
        requested: fulfillmentDecimal(quantity),
      },
    );
  const after = fulfillmentOption(
    binding.reservation,
    'reservation_state',
    'active',
  );
  const updated = await client.query<{ revision: number }>(
    `UPDATE ${fulfillmentTable(binding.reservation)}
        SET ${q(fulfillmentColumn(binding.reservation, 'reservation_state'))}=$5,
            revision=revision+1
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(binding.reservation.legalEntity!.column)}=$3
        AND record_id=$4 AND revision=$6
      RETURNING revision`,
    [
      request.context.tenantId,
      request.context.environmentId,
      prepared.legalEntityId,
      prepared.recordId,
      after,
      prepared.expectedRevision,
    ],
  );
  if (updated.rows.length !== 1)
    throw fulfillmentError(
      'FULFILLMENT_RESERVATION_STATE_CONFLICT',
      'Reservation changed while it was being reserved',
    );
  await writeReservationBalance(
    client,
    binding,
    request,
    prepared.legalEntityId,
    prepared.recordId,
    fulfillmentDecimal(quantity),
    unitId,
  );
  return transition(prepared, Number(updated.rows[0]!.revision), before, after);
}

async function release(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  prepared: PreparedFulfillmentTarget,
): Promise<TransitionResult> {
  const reservation = await fulfillmentRow(
    client,
    binding.reservation,
    request.context,
    prepared.legalEntityId,
    prepared.recordId,
    true,
  );
  assertCurrent(reservation, prepared);
  const before = String(
    reservation[fulfillmentColumn(binding.reservation, 'reservation_state')],
  );
  const releasable = ['active', 'partially_consumed'].map((state) =>
    fulfillmentOption(binding.reservation, 'reservation_state', state),
  );
  const reason =
    reservation[fulfillmentColumn(binding.reservation, 'reservation_reason')];
  if (
    !releasable.includes(before) ||
    typeof reason !== 'string' ||
    reason.trim().length === 0
  )
    throw fulfillmentError(
      'FULFILLMENT_RESERVATION_STATE_CONFLICT',
      'Release requires a live reservation and an explicit release reason',
    );
  const remaining = await reservationRemaining(
    client,
    binding,
    request,
    prepared.legalEntityId,
    reservation,
  );
  if (remaining <= 0n)
    throw fulfillmentError(
      'FULFILLMENT_RESERVATION_STATE_CONFLICT',
      'A fully consumed reservation has nothing to release',
    );
  const after = fulfillmentOption(
    binding.reservation,
    'reservation_state',
    'released',
  );
  const updated = await client.query<{ revision: number }>(
    `UPDATE ${fulfillmentTable(binding.reservation)}
        SET ${q(fulfillmentColumn(binding.reservation, 'reservation_state'))}=$5,
            revision=revision+1
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(binding.reservation.legalEntity!.column)}=$3
        AND record_id=$4 AND revision=$6
      RETURNING revision`,
    [
      request.context.tenantId,
      request.context.environmentId,
      prepared.legalEntityId,
      prepared.recordId,
      after,
      prepared.expectedRevision,
    ],
  );
  if (updated.rows.length !== 1)
    throw fulfillmentError(
      'FULFILLMENT_RESERVATION_STATE_CONFLICT',
      'Reservation changed while it was being released',
    );
  await writeReservationBalance(
    client,
    binding,
    request,
    prepared.legalEntityId,
    prepared.recordId,
    '0',
    String(
      reservation[
        fulfillmentColumn(binding.reservation, 'reservation_unit_id')
      ],
    ),
  );
  return transition(prepared, Number(updated.rows[0]!.revision), before, after);
}

async function changeOrder(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  prepared: PreparedFulfillmentTarget,
  action: 'close' | 'cancel',
): Promise<TransitionResult> {
  const order = await fulfillmentRow(
    client,
    binding.order,
    request.context,
    prepared.legalEntityId,
    prepared.recordId,
    true,
  );
  assertCurrent(order, prepared);
  assertReleasedOrder(binding, order);
  const stateColumn = fulfillmentColumn(
    binding.order,
    'derived_state_field.machine.sales_order_lifecycle',
  );
  const before = String(order[stateColumn]);
  const lines = await client.query<FulfillmentRow>(
    `SELECT * FROM ${fulfillmentTable(binding.orderLine)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(binding.orderLine.legalEntity!.column)}=$3
        AND ${q(fulfillmentRelation(binding, binding.orderLine, 'sales_order_line_order'))}=$4
        AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
    [
      request.context.tenantId,
      request.context.environmentId,
      prepared.legalEntityId,
      prepared.recordId,
    ],
  );
  if (lines.rows.length === 0)
    throw fulfillmentError(
      'FULFILLMENT_QUANTITY_OUT_OF_BOUNDS',
      'A released order without lines cannot be closed or cancelled',
    );
  for (const line of lines.rows) {
    const ordered = fulfillmentQuantity(
      String(
        line[
          fulfillmentColumn(
            binding.orderLine,
            'sales_order_line_ordered_quantity',
          )
        ],
      ),
    );
    const shipped = await shippedQuantity(
      client,
      binding,
      request,
      prepared.legalEntityId,
      String(line.record_id),
    );
    if (action === 'close' ? shipped !== ordered : shipped !== 0n)
      throw fulfillmentError(
        'FULFILLMENT_QUANTITY_OUT_OF_BOUNDS',
        action === 'close'
          ? 'Close requires every order line to be shipped exactly in full'
          : 'Cancellation is refused after any net shipment; post a linked correction first',
        { orderLineId: String(line.record_id) },
      );
  }
  const reservationRows = await client.query<FulfillmentRow>(
    `SELECT r.* FROM ${fulfillmentTable(binding.reservation)} r
      JOIN ${fulfillmentTable(binding.orderLine)} l
        ON l.tenant_id=r.tenant_id AND l.environment_id=r.environment_id
       AND l.${q(binding.orderLine.legalEntity!.column)}=r.${q(binding.reservation.legalEntity!.column)}
       AND l.record_id=r.${q(fulfillmentRelation(binding, binding.reservation, 'reservation_order_line'))}
      WHERE r.tenant_id=$1 AND r.environment_id=$2
        AND r.${q(binding.reservation.legalEntity!.column)}=$3
        AND l.${q(fulfillmentRelation(binding, binding.orderLine, 'sales_order_line_order'))}=$4
        AND r.archived_at IS NULL ORDER BY r.record_id FOR NO KEY UPDATE OF r`,
    [
      request.context.tenantId,
      request.context.environmentId,
      prepared.legalEntityId,
      prepared.recordId,
    ],
  );
  const releasedReservationIds: string[] = [];
  if (action === 'cancel') {
    const released = fulfillmentOption(
      binding.reservation,
      'reservation_state',
      'released',
    );
    const live = new Set(
      ['active', 'partially_consumed'].map((state) =>
        fulfillmentOption(binding.reservation, 'reservation_state', state),
      ),
    );
    for (const reservation of reservationRows.rows) {
      const state = String(
        reservation[
          fulfillmentColumn(binding.reservation, 'reservation_state')
        ],
      );
      if (!live.has(state)) continue;
      const changed = await client.query(
        `UPDATE ${fulfillmentTable(binding.reservation)}
            SET ${q(fulfillmentColumn(binding.reservation, 'reservation_state'))}=$5,
                revision=revision+1
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${q(binding.reservation.legalEntity!.column)}=$3
            AND record_id=$4 AND revision=$6`,
        [
          request.context.tenantId,
          request.context.environmentId,
          prepared.legalEntityId,
          reservation.record_id,
          released,
          reservation.revision,
        ],
      );
      if (changed.rowCount !== 1)
        throw fulfillmentError(
          'FULFILLMENT_RESERVATION_STATE_CONFLICT',
          'A reservation changed while the order was being cancelled',
        );
      await writeReservationBalance(
        client,
        binding,
        request,
        prepared.legalEntityId,
        String(reservation.record_id),
        '0',
        String(
          reservation[
            fulfillmentColumn(binding.reservation, 'reservation_unit_id')
          ],
        ),
      );
      releasedReservationIds.push(String(reservation.record_id));
    }
  } else {
    for (const reservation of reservationRows.rows) {
      const remaining = await reservationRemaining(
        client,
        binding,
        request,
        prepared.legalEntityId,
        reservation,
      );
      const state = String(
        reservation[
          fulfillmentColumn(binding.reservation, 'reservation_state')
        ],
      );
      if (
        remaining > 0n &&
        state !==
          fulfillmentOption(
            binding.reservation,
            'reservation_state',
            'released',
          )
      )
        throw fulfillmentError(
          'FULFILLMENT_RESERVATION_STATE_CONFLICT',
          'Close requires every live reservation to be fully consumed or explicitly released',
        );
    }
  }
  const after = `${binding.order.entityId.split(':entity.')[0]}:state.sales_order_${action === 'close' ? 'closed' : 'cancelled'}`;
  const updated = await client.query<{ revision: number }>(
    `UPDATE ${fulfillmentTable(binding.order)} SET ${q(stateColumn)}=$5,revision=revision+1
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(binding.order.legalEntity!.column)}=$3
        AND record_id=$4 AND revision=$6 RETURNING revision`,
    [
      request.context.tenantId,
      request.context.environmentId,
      prepared.legalEntityId,
      prepared.recordId,
      after,
      prepared.expectedRevision,
    ],
  );
  if (updated.rows.length !== 1)
    throw fulfillmentError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      'Order changed during fulfillment transition',
    );
  return {
    ...transition(prepared, Number(updated.rows[0]!.revision), before, after),
    releasedReservationIds,
  };
}

function assertCurrent(
  row: FulfillmentRow,
  prepared: PreparedFulfillmentTarget,
): void {
  const revision = Number(row.revision);
  if (
    row.archived_at !== null ||
    revision !== prepared.currentRevision ||
    revision !== prepared.expectedRevision
  )
    throw fulfillmentError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      'Fulfillment target scope or revision changed after authorization',
    );
}

function assertReleasedOrder(
  binding: FulfillmentBinding,
  order: FulfillmentRow,
): void {
  const state =
    order[
      fulfillmentColumn(
        binding.order,
        'derived_state_field.machine.sales_order_lifecycle',
      )
    ];
  if (!String(state).endsWith(':state.sales_order_released'))
    throw fulfillmentError(
      'FULFILLMENT_ORDER_NOT_RELEASED',
      'Fulfillment requires a released sales order',
    );
}

async function assertActiveCustomer(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  order: FulfillmentRow,
): Promise<void> {
  const partyId = String(
    order[fulfillmentColumn(binding.order, 'sales_order_customer_party_id')],
  );
  const result = await client.query(
    `SELECT 1 FROM ${fulfillmentTable(binding.party)} p
      JOIN ${fulfillmentTable(binding.partyRole)} r
        ON r.tenant_id=p.tenant_id AND r.environment_id=p.environment_id
       AND r.${q(fulfillmentRelation(binding, binding.partyRole, 'party_role_party'))}=p.record_id
      WHERE p.tenant_id=$1 AND p.environment_id=$2 AND p.record_id=$3
        AND p.archived_at IS NULL AND r.archived_at IS NULL
        AND r.${q(fulfillmentColumn(binding.partyRole, 'party_role_kind'))}=$4
        AND r.${q(fulfillmentColumn(binding.partyRole, 'party_role_status'))}=$5
      LIMIT 1 FOR NO KEY UPDATE OF p, r`,
    [
      request.context.tenantId,
      request.context.environmentId,
      partyId,
      fulfillmentOption(binding.partyRole, 'party_role_kind', 'customer'),
      fulfillmentOption(binding.partyRole, 'party_role_status', 'active'),
    ],
  );
  if (result.rows.length !== 1)
    throw fulfillmentError(
      'FULFILLMENT_CUSTOMER_INELIGIBLE',
      'Sales order customer must be an active, unarchived customer party',
      { partyId },
    );
}

async function assertItemLocation(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  itemId: string,
  locationId: string,
  unitId: string,
): Promise<void> {
  const item = await client.query<{ unit: string }>(
    `SELECT ${q(fulfillmentColumn(binding.item, 'item_base_unit'))}::text AS unit
       FROM ${fulfillmentTable(binding.item)}
      WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3
        AND archived_at IS NULL FOR NO KEY UPDATE`,
    [request.context.tenantId, request.context.environmentId, itemId],
  );
  if (item.rows.length !== 1)
    throw fulfillmentError(
      'INVENTORY_ITEM_INACTIVE',
      'Item is missing or archived',
    );
  if (item.rows[0]!.unit !== unitId)
    throw fulfillmentError(
      'INVENTORY_ITEM_UNIT_MISMATCH',
      'Reservation must use the item base unit',
      { expectedUnit: item.rows[0]!.unit, requestedUnit: unitId },
    );
  const location = await client.query(
    `SELECT 1 FROM ${fulfillmentTable(binding.location)}
      WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3
        AND archived_at IS NULL FOR NO KEY UPDATE`,
    [request.context.tenantId, request.context.environmentId, locationId],
  );
  if (location.rows.length !== 1)
    throw fulfillmentError(
      'INVENTORY_LOCATION_INACTIVE',
      'Location is missing or archived',
    );
}

async function onHandQuantity(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  legalEntityId: string,
  itemId: string,
  locationId: string,
): Promise<bigint> {
  const result = await client.query<{ quantity: string }>(
    `SELECT coalesce(sum(${q(fulfillmentColumn(binding.balance, 'posted_stock_balance_posted_quantity'))}),0)::text AS quantity
       FROM ${fulfillmentTable(binding.balance)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(binding.balance.legalEntity!.column)}=$3
        AND ${q(fulfillmentColumn(binding.balance, 'posted_stock_balance_item_id'))}=$4
        AND ${q(fulfillmentColumn(binding.balance, 'posted_stock_balance_location_id'))}=$5
        AND archived_at IS NULL`,
    [
      request.context.tenantId,
      request.context.environmentId,
      legalEntityId,
      itemId,
      locationId,
    ],
  );
  return fulfillmentQuantity(result.rows[0]!.quantity);
}

async function writeReservationBalance(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  legalEntityId: string,
  reservationId: string,
  remainingQuantity: string,
  unitId: string,
): Promise<void> {
  const entity = binding.reservationBalance;
  const recordId = fulfillmentProjectionIdentity(
    request.context,
    legalEntityId,
    'reservation',
    reservationId,
  );
  await client.query('SET LOCAL ROLE north_star_fulfillment_projection_writer');
  await client.query(
    `INSERT INTO ${fulfillmentTable(entity)} AS balance
      (tenant_id,environment_id,${q(entity.legalEntity!.column)},record_id,revision,archived_at,
       ${q(fulfillmentRelation(binding, entity, 'reservation_balance_reservation'))},
       ${q(fulfillmentColumn(entity, 'reservation_balance_remaining_quantity'))},
       ${q(fulfillmentColumn(entity, 'reservation_balance_unit_id'))})
     VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7)
     ON CONFLICT (tenant_id,environment_id,${q(entity.legalEntity!.column)},record_id)
     DO UPDATE SET revision=balance.revision+1,archived_at=NULL,
       ${q(fulfillmentColumn(entity, 'reservation_balance_remaining_quantity'))}=EXCLUDED.${q(fulfillmentColumn(entity, 'reservation_balance_remaining_quantity'))},
       ${q(fulfillmentColumn(entity, 'reservation_balance_unit_id'))}=EXCLUDED.${q(fulfillmentColumn(entity, 'reservation_balance_unit_id'))}`,
    [
      request.context.tenantId,
      request.context.environmentId,
      legalEntityId,
      recordId,
      reservationId,
      remainingQuantity,
      unitId,
    ],
  );
  const observed = await client.query<{ quantity: string; unit: string }>(
    `SELECT ${q(fulfillmentColumn(entity, 'reservation_balance_remaining_quantity'))}::text AS quantity,
            ${q(fulfillmentColumn(entity, 'reservation_balance_unit_id'))}::text AS unit
       FROM ${fulfillmentTable(entity)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(entity.legalEntity!.column)}=$3 AND record_id=$4`,
    [
      request.context.tenantId,
      request.context.environmentId,
      legalEntityId,
      recordId,
    ],
  );
  await client.query('SET LOCAL ROLE north_star_module_runtime');
  if (
    observed.rows.length !== 1 ||
    fulfillmentQuantity(observed.rows[0]!.quantity) !==
      fulfillmentQuantity(remainingQuantity) ||
    observed.rows[0]!.unit !== unitId
  )
    throw fulfillmentError(
      'INVENTORY_POSTING_STORAGE_REJECTED',
      'Reservation coverage projection did not match the committed consequence',
    );
}

export async function reservationRemaining(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  legalEntityId: string,
  reservation: FulfillmentRow,
): Promise<bigint> {
  const original = fulfillmentQuantity(
    String(
      reservation[
        fulfillmentColumn(binding.reservation, 'reservation_quantity')
      ],
    ),
  );
  const result = await client.query<{ consumed: string }>(
    `SELECT coalesce(sum(-m.${q(fulfillmentColumn(binding.movement, 'inventory_movement_quantity_delta'))}),0)::text AS consumed
       FROM ${fulfillmentTable(binding.movement)} m
       JOIN ${fulfillmentTable(binding.shipmentLine)} sl
         ON sl.tenant_id=m.tenant_id AND sl.environment_id=m.environment_id
        AND sl.${q(binding.shipmentLine.legalEntity!.column)}=m.${q(binding.movement.legalEntity!.column)}
        AND sl.record_id::text=m.${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_line'))}
      WHERE m.tenant_id=$1 AND m.environment_id=$2
        AND m.${q(binding.movement.legalEntity!.column)}=$3
        AND sl.${q(fulfillmentRelation(binding, binding.shipmentLine, 'shipment_line_reservation'))}=$4
        AND m.${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_type'))}='shipment'
        AND m.archived_at IS NULL`,
    [
      request.context.tenantId,
      request.context.environmentId,
      legalEntityId,
      reservation.record_id,
    ],
  );
  return original - fulfillmentQuantity(result.rows[0]!.consumed);
}

async function reservedQuantity(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  legalEntityId: string,
  filter: { itemId: string; locationId: string } | { orderLineId: string },
): Promise<bigint> {
  const states = ['active', 'partially_consumed', 'consumed'].map((state) =>
    fulfillmentOption(binding.reservation, 'reservation_state', state),
  );
  const values: unknown[] = [
    request.context.tenantId,
    request.context.environmentId,
    legalEntityId,
    states,
  ];
  const predicate =
    'orderLineId' in filter
      ? (() => {
          values.push(filter.orderLineId);
          return `AND ${q(fulfillmentRelation(binding, binding.reservation, 'reservation_order_line'))}=$5`;
        })()
      : (() => {
          values.push(filter.itemId, filter.locationId);
          return `AND ${q(fulfillmentColumn(binding.reservation, 'reservation_item_id'))}=$5 AND ${q(fulfillmentColumn(binding.reservation, 'reservation_location_id'))}=$6`;
        })();
  const rows = await client.query<FulfillmentRow>(
    `SELECT * FROM ${fulfillmentTable(binding.reservation)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(binding.reservation.legalEntity!.column)}=$3
        AND ${q(fulfillmentColumn(binding.reservation, 'reservation_state'))}=ANY($4::text[])
        AND archived_at IS NULL ${predicate}
      ORDER BY record_id FOR NO KEY UPDATE`,
    values,
  );
  let total = 0n;
  for (const row of rows.rows) {
    const remaining = await reservationRemaining(
      client,
      binding,
      request,
      legalEntityId,
      row,
    );
    if (remaining < 0n)
      throw fulfillmentError(
        'FULFILLMENT_RESERVATION_STATE_CONFLICT',
        'Reservation history reconstructs a negative remaining quantity',
      );
    total += remaining;
  }
  return total;
}

export async function shippedQuantity(
  client: PoolClient,
  binding: FulfillmentBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  legalEntityId: string,
  orderLineId: string,
): Promise<bigint> {
  const result = await client.query<{ quantity: string }>(
    `SELECT coalesce(sum(${q(fulfillmentColumn(binding.shipped, 'sales_order_shipped_shipped_quantity'))}),0)::text AS quantity
       FROM ${fulfillmentTable(binding.shipped)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(binding.shipped.legalEntity!.column)}=$3
        AND ${q(fulfillmentRelation(binding, binding.shipped, 'sales_order_shipped_order_line'))}=$4
        AND archived_at IS NULL`,
    [
      request.context.tenantId,
      request.context.environmentId,
      legalEntityId,
      orderLineId,
    ],
  );
  return fulfillmentQuantity(result.rows[0]!.quantity);
}

function transition(
  prepared: PreparedFulfillmentTarget,
  revision: number,
  before: string,
  after: string,
): TransitionResult {
  return {
    recordId: prepared.recordId,
    legalEntityId: prepared.legalEntityId,
    revision,
    before,
    after,
    releasedReservationIds: [],
  };
}

async function fulfillmentReadBack(
  context: PostgresCapabilityOperationExecutorContext,
  request: RegisteredCapabilityOperationExecutionRequest,
  trust: {
    readonly changeDocumentId: string;
    readonly domainEventId: string;
    readonly invocationId: string;
    readonly outboxId: string;
    readonly mutationResult: { readonly recordId: string };
  },
): Promise<SemanticOperationResultEnvelope> {
  let record: SemanticOperationResultEnvelope['readBack'] = null;
  try {
    const result = await context.queryGateway.invoke(request.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: request.readBackDefinition.queryId,
      arguments: request.authorization.readBackArguments,
    });
    record =
      result.records.find(
        (row) => row.recordId === trust.mutationResult.recordId,
      ) ?? null;
    if (result.outcome !== 'exact' || !record)
      throw fulfillmentError(
        'INVENTORY_POSTING_STORAGE_REJECTED',
        'Fulfillment transition did not read back exactly',
      );
  } catch (error) {
    if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
  }
  return {
    kind: 'semanticOperationResult',
    schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
    operationId: request.definition.operationId,
    outcome: 'succeeded',
    readBack: record,
    trust: {
      changeDocumentId: trust.changeDocumentId,
      domainEventId: trust.domainEventId,
      invocationId: trust.invocationId,
      outboxId: trust.outboxId,
    },
    unsupportedReason: null,
  };
}

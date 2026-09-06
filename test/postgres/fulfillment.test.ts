import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import {
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_CAPABILITY_ID,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
  deriveInventoryPostingCompanionId,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  FULFILLMENT_CAPABILITY_ID,
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentQuantity,
  fulfillmentRelation,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { reconcileFulfillmentProjections } from '../../packages/postgres-provider/src/fulfillment-projections.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-service.js';
import { TrustEvidenceError } from '../../packages/postgres-provider/src/trust/postgres-trust-service.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationPolicyDeniedError,
  parsePinnedOperationCatalog,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import { governedStorageTargetArtifact } from '../helpers/governed-storage-target.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const ns = 'northstar.app';
const legalEntityId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const customerPartyId = '71000000-0000-4000-8000-000000000001';
const itemId = '71000000-0000-4000-8000-000000000011';
const locationA = '71000000-0000-4000-8000-000000000021';

test(
  'fulfillment serializes competing reservations and shipments, fences stock writers, and rebuilds projections',
  { timeout: 300_000 },
  async () => {
    await withEphemeralPostgres(
      'fulfillment-critical',
      async ({ connection, pool }) => {
        const app = await startComposedApplication({
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          port: 0,
          tenantSlug: 'fulfillment-critical',
        });
        try {
          const runtime = app.runtime;
          const invoke = (
            local: string,
            input: ImmutableJsonValue,
            idempotencyKey = randomUUID(),
          ) =>
            runtime.entry.run({ headers: {} }, (view) => {
              const operationId = `${ns}:operation.${local}`;
              const confirmation = parsePinnedOperationCatalog(
                view.projections.operation.payload,
              ).find(
                (operation) => operation.operationId === operationId,
              )?.confirmation;
              return runtime.operationGateway.invoke(
                view,
                {
                  confirmationGrant:
                    confirmation === 'humanRequired'
                      ? runtime.operationMediation.issueConfirmationGrant(
                          view,
                          operationId,
                          input,
                        )
                      : null,
                  idempotencyKey,
                  input,
                  operationId,
                  schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                },
                runtime.operationMediation.issueInvocation(view, 'UI'),
              );
            });
          const create = async (
            local: string,
            values: Record<string, ImmutableJsonValue>,
            relations: Record<string, string | null> = {},
            scoped = true,
          ) => {
            const recordId = randomUUID();
            const result = await invoke(`${local}_create`, {
              ...(scoped ? { legalEntityId } : {}),
              recordId,
              relations: Object.fromEntries(
                Object.entries(relations)
                  .filter(([, value]) => value !== null)
                  .map(([name, value]) => [
                    `${ns}:relation.${local}_${name}`,
                    value,
                  ]),
              ),
              values: Object.fromEntries(
                Object.entries(values).map(([name, value]) => [
                  `${ns}:field.${local}_${name}`,
                  value,
                ]),
              ),
            });
            assert.equal(result.outcome, 'succeeded');
            assert.ok(result.readBack);
            return { recordId, revision: result.readBack.revision };
          };
          const transition = (
            local: string,
            recordId: string,
            expectedRevision: number,
            key = randomUUID(),
          ) => invoke(local, { expectedRevision, recordId }, key);

          const now = new Date().toISOString();
          const stock = await create('inventory_transaction', {
            actor_id: 'fulfillment-test',
            effective_at: now,
            number: `ADJ-${randomUUID()}`,
            reason_code: 'SETUP',
            reason_narrative: 'Fulfillment concurrency stock',
            recorded_at: now,
            source_id: randomUUID(),
            source_type: 'test',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_adjustment`,
          });
          await create(
            'inventory_transaction_line',
            {
              from_location_id: null,
              item_id: itemId,
              line_number: '1',
              quantity: '10',
              to_location_id: locationA,
              unit_id: 'EA',
            },
            { transaction: stock.recordId },
          );
          await transition(
            'inventory_transaction_post',
            stock.recordId,
            stock.revision,
          );

          const order = await create('sales_order', {
            currency: 'CAD',
            customer_party_id: customerPartyId,
            notes: 'Critical fulfillment race',
            number: `SO-${randomUUID()}`,
            order_date: now,
            requested_date: now,
          });
          const line = await create(
            'sales_order_line',
            {
              item_id: itemId,
              line_number: '1',
              ordered_quantity: '10',
              unit_id: 'EA',
              unit_price: null,
            },
            { order: order.recordId },
          );
          const released = await transition(
            'sales_order_release',
            order.recordId,
            order.revision,
          );
          assert.equal(released.outcome, 'succeeded');

          const reservation = async (
            quantity: string,
            locationId = locationA,
            orderLineId = line.recordId,
          ) =>
            create(
              'reservation',
              {
                item_id: itemId,
                location_id: locationId,
                number: `RSV-${randomUUID()}`,
                quantity,
                reason: 'Explicit release reason',
                state: `${ns}:option.reservation_state_draft`,
                unit_id: 'EA',
              },
              { order_line: orderLineId },
            );
          const eligibilityProbe = await reservation('1');
          await assert.rejects(
            transition(
              'reservation_reserve',
              eligibilityProbe.recordId,
              eligibilityProbe.revision,
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'FULFILLMENT_CUSTOMER_INELIGIBLE',
            'reserve must revalidate the current active customer role for a previously created order',
          );
          const customerRole = await create(
            'party_role',
            {
              kind: `${ns}:option.customer`,
              status: `${ns}:option.active`,
            },
            { party: customerPartyId },
            false,
          );
          const first = await reservation('6');
          const second = await reservation('6');
          await assert.rejects(
            transition(
              'reservation_reserve',
              first.recordId,
              first.revision + 1,
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'INVENTORY_TRANSACTION_STATE_CONFLICT',
          );
          const firstKey = randomUUID();
          const secondKey = randomUUID();
          const competing = await Promise.allSettled([
            transition(
              'reservation_reserve',
              first.recordId,
              first.revision,
              firstKey,
            ),
            transition(
              'reservation_reserve',
              second.recordId,
              second.revision,
              secondKey,
            ),
          ]);
          assert.equal(
            competing.filter((result) => result.status === 'fulfilled').length,
            1,
            'competing reservations must have exactly one winner',
          );
          const refused = competing.find(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          );
          assert.ok(refused);
          assert.ok(refused.reason instanceof InventoryPostingError);
          assert.ok(
            [
              'FULFILLMENT_RESERVATION_SHORTAGE',
              'FULFILLMENT_QUANTITY_OUT_OF_BOUNDS',
            ].includes(refused.reason.code),
          );
          const active = competing[0]!.status === 'fulfilled' ? first : second;
          const activeKey = active === first ? firstKey : secondKey;
          const activeReserveResult = competing.find(
            (
              result,
            ): result is PromiseFulfilledResult<
              Awaited<ReturnType<typeof transition>>
            > => result.status === 'fulfilled',
          )!.value;
          const inactive = active === first ? second : first;
          await assert.doesNotReject(async () => {
            const replay = await transition(
              'reservation_reserve',
              active.recordId,
              active.revision,
              activeKey,
            );
            assert.equal(replay.outcome, 'succeeded');
          }, 'an exact reservation retry must replay without executing again');
          await assert.rejects(
            transition(
              'reservation_reserve',
              inactive.recordId,
              inactive.revision,
              activeKey,
            ),
            (error: unknown) =>
              error instanceof TrustEvidenceError &&
              error.code === 'SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT',
            'a conflicting reservation retry must be refused',
          );

          // Existing stock reducers cannot leave on-hand below live coverage.
          const reduction = await create('inventory_transaction', {
            actor_id: 'fulfillment-test',
            effective_at: now,
            number: `ADJ-REDUCE-${randomUUID()}`,
            reason_code: 'REDUCE',
            reason_narrative: 'Must not bypass reservation',
            recorded_at: now,
            source_id: randomUUID(),
            source_type: 'test',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_adjustment`,
          });
          await create(
            'inventory_transaction_line',
            {
              from_location_id: locationA,
              item_id: itemId,
              line_number: '1',
              quantity: '-5',
              to_location_id: null,
              unit_id: 'EA',
            },
            { transaction: reduction.recordId },
          );
          await assert.rejects(
            transition(
              'inventory_transaction_post',
              reduction.recordId,
              reduction.revision,
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'FULFILLMENT_RESERVATION_SHORTAGE',
            'an adjustment must not reduce stock below live reservations',
          );

          const locationCodeSuffix = randomUUID().slice(0, 8);
          const secondaryLocation = await create(
            'location',
            {
              code: `FUL-${locationCodeSuffix}`,
              name: 'Fulfillment secondary warehouse',
              type: `${ns}:option.warehouse`,
            },
            {},
            false,
          );
          const locationB = secondaryLocation.recordId;
          const transferSourceId = randomUUID();
          const transfer = await create('inventory_transaction', {
            actor_id: 'fulfillment-test',
            effective_at: now,
            number: `TRN-RESERVED-${randomUUID()}`,
            reason_code: 'WAREHOUSE-TRANSFER',
            reason_narrative: null,
            recorded_at: now,
            source_id: transferSourceId,
            source_type: 'transfer',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_transfer`,
          });
          const transferLine = await create(
            'inventory_transaction_line',
            {
              from_location_id: locationA,
              item_id: itemId,
              line_number: '1',
              quantity: '5',
              to_location_id: locationB,
              unit_id: 'EA',
            },
            { transaction: transfer.recordId },
          );
          const storageArtifact = await governedStorageTargetArtifact();
          const target = storageArtifact.payload;
          const directRecordedAt = new Date(
            Date.parse(now) + 1_000,
          ).toISOString();
          const directRuntimePool = new pg.Pool({
            ...connection,
            user: 'north_star_runtime',
          });
          try {
            const context = await new AuthenticatedRequestEntryAdapter(
              async () => runtime.identity,
            ).enter({});
            const actor = await new TrustedActorEnvelopeIssuer({
              resolve: async () => ({
                approvingHumanId: null,
                delegation: null,
                executionPrincipal: {
                  kind: 'HUMAN',
                  principalId: runtime.identity.principalId,
                },
                initiatingHumanId: runtime.identity.principalId,
                subject: null,
              }),
            }).issue(context);
            const service = new PostgresInventoryPostingService(
              directRuntimePool,
              {
                capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
                capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
                dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
                releaseContentHash: runtime.releaseRoot,
                releaseId: runtime.activeReleaseId,
                storageTarget: target,
                storageTargetContentHash: storageArtifact.contentHash,
              },
              { currentInstant: () => directRecordedAt },
            );
            await assert.rejects(
              service.postTransfer(context, actor, {
                authorization: {
                  decision: 'ALLOW',
                  evaluatorVersion: 'northstar.test-policy-evaluator/v1',
                  policyVersion: 'northstar.test-policy/v1',
                },
                channel: 'API',
                effectiveAt: now,
                idempotencyKey: randomUUID(),
                legalEntityId,
                lines: [
                  {
                    fromLocationId: locationA,
                    itemId,
                    quantity: '5',
                    sourceLine: '1',
                    toLocationId: locationB,
                    transactionLineId: transferLine.recordId,
                    unitId: 'EA',
                  },
                ],
                reason: { code: 'WAREHOUSE-TRANSFER', narrative: null },
                sourceId: transferSourceId,
                sourceRevision: transfer.revision,
                sourceType: 'transfer',
                stockDimensionSetVersion: 'v1',
                transactionId: transfer.recordId,
              }),
              (error: unknown) =>
                error instanceof InventoryPostingError &&
                error.code === 'FULFILLMENT_RESERVATION_SHORTAGE',
              'a transfer must not reduce stock below live reservations',
            );
          } finally {
            await directRuntimePool.end();
          }
          const secondaryStock = await create('inventory_transaction', {
            actor_id: 'fulfillment-test',
            effective_at: now,
            number: `ADJ-B-${randomUUID()}`,
            reason_code: 'SETUP',
            reason_narrative: 'Cross-location order-bound stock',
            recorded_at: now,
            source_id: randomUUID(),
            source_type: 'test',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_adjustment`,
          });
          await create(
            'inventory_transaction_line',
            {
              from_location_id: null,
              item_id: itemId,
              line_number: '1',
              quantity: '10',
              to_location_id: locationB,
              unit_id: 'EA',
            },
            { transaction: secondaryStock.recordId },
          );
          await transition(
            'inventory_transaction_post',
            secondaryStock.recordId,
            secondaryStock.revision,
          );
          const crossLocation = await reservation('5', locationB);
          await assert.rejects(
            transition(
              'reservation_reserve',
              crossLocation.recordId,
              crossLocation.revision,
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'FULFILLMENT_QUANTITY_OUT_OF_BOUNDS',
            'cross-location reservations must share the order-line bound',
          );

          const shipment = async (
            quantity: string,
            options: {
              kind?: 'initial' | 'correction' | 'reversal';
              locationId?: string;
              orderId?: string;
              orderLineId?: string;
              reservationId?: string;
              reversalOfMovementId?: string;
              supersedesShipmentId?: string;
            } = {},
          ) => {
            const kind = options.kind ?? 'initial';
            const header = await create(
              'shipment',
              {
                effective_at: now,
                external_reference: randomUUID(),
                kind: `${ns}:option.shipment_kind_${kind}`,
                location_id: options.locationId ?? locationA,
                number: `SHP-${randomUUID()}`,
                reason_code: 'SHIP',
                reason_narrative: 'Competing shipment',
                state: `${ns}:option.shipment_state_draft`,
              },
              {
                order: options.orderId ?? order.recordId,
                supersedes: options.supersedesShipmentId ?? null,
              },
            );
            await create(
              'shipment_line',
              {
                item_id: itemId,
                line_number: '1',
                quantity,
                reversal_of_movement_id: options.reversalOfMovementId ?? null,
                unit_id: 'EA',
              },
              {
                order_line: options.orderLineId ?? line.recordId,
                reservation: options.reservationId ?? active.recordId,
                shipment: header.recordId,
              },
            );
            return header;
          };

          // F1 review regression. Build an independent exact five-unit loop at
          // location B, consume all coverage, permit an ordinary negative
          // adjustment while live coverage is zero, then attempt a correction
          // that would restore one unit of reservation against zero stock.
          const trimSecondaryStock = await create('inventory_transaction', {
            actor_id: 'fulfillment-test',
            effective_at: now,
            number: `ADJ-B-TRIM-${randomUUID()}`,
            reason_code: 'SETUP',
            reason_narrative: 'Leave exactly five for correction coverage',
            recorded_at: now,
            source_id: randomUUID(),
            source_type: 'test',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_adjustment`,
          });
          await create(
            'inventory_transaction_line',
            {
              from_location_id: locationB,
              item_id: itemId,
              line_number: '1',
              quantity: '-5',
              to_location_id: null,
              unit_id: 'EA',
            },
            { transaction: trimSecondaryStock.recordId },
          );
          await transition(
            'inventory_transaction_post',
            trimSecondaryStock.recordId,
            trimSecondaryStock.revision,
          );
          const correctionOrder = await create('sales_order', {
            currency: 'CAD',
            customer_party_id: customerPartyId,
            notes: 'Resulting reservation coverage regression',
            number: `SO-COVERAGE-${randomUUID()}`,
            order_date: now,
            requested_date: now,
          });
          const correctionOrderLine = await create(
            'sales_order_line',
            {
              item_id: itemId,
              line_number: '1',
              ordered_quantity: '5',
              unit_id: 'EA',
              unit_price: null,
            },
            { order: correctionOrder.recordId },
          );
          await transition(
            'sales_order_release',
            correctionOrder.recordId,
            correctionOrder.revision,
          );
          const correctionReservation = await reservation(
            '5',
            locationB,
            correctionOrderLine.recordId,
          );
          await transition(
            'reservation_reserve',
            correctionReservation.recordId,
            correctionReservation.revision,
          );
          const fullyConsumedShipment = await shipment('5', {
            locationId: locationB,
            orderId: correctionOrder.recordId,
            orderLineId: correctionOrderLine.recordId,
            reservationId: correctionReservation.recordId,
          });
          await transition(
            'shipment_post',
            fullyConsumedShipment.recordId,
            fullyConsumedShipment.revision,
          );
          const binding = fulfillmentBinding(target)!;
          const consumedMovement = await pool.query<{ record_id: string }>(
            `SELECT record_id::text FROM ${fulfillmentTable(binding.movement)}
              WHERE tenant_id=$1 AND environment_id=$2
                AND ${q(binding.movement.legalEntity!.column)}=$3
                AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_type'))}='shipment'
                AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_id'))}=$4`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              legalEntityId,
              fullyConsumedShipment.recordId,
            ],
          );
          assert.equal(consumedMovement.rows.length, 1);
          await pool.query(
            `UPDATE platform.inventory_posting_configurations
                SET negative_stock='allowWithFlag',revision=revision+1
              WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              legalEntityId,
            ],
          );
          const negativeAdjustment = await create('inventory_transaction', {
            actor_id: 'fulfillment-test',
            effective_at: now,
            number: `ADJ-B-NEGATIVE-${randomUUID()}`,
            reason_code: 'NEGATIVE',
            reason_narrative: 'Native allow-with-flag control at zero coverage',
            recorded_at: now,
            source_id: randomUUID(),
            source_type: 'test',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_adjustment`,
          });
          await create(
            'inventory_transaction_line',
            {
              from_location_id: locationB,
              item_id: itemId,
              line_number: '1',
              quantity: '-1',
              to_location_id: null,
              unit_id: 'EA',
            },
            { transaction: negativeAdjustment.recordId },
          );
          await transition(
            'inventory_transaction_post',
            negativeAdjustment.recordId,
            negativeAdjustment.revision,
          );
          const unbackedCorrection = await shipment('1', {
            kind: 'correction',
            locationId: locationB,
            orderId: correctionOrder.recordId,
            orderLineId: correctionOrderLine.recordId,
            reservationId: correctionReservation.recordId,
            reversalOfMovementId: consumedMovement.rows[0]!.record_id,
            supersedesShipmentId: fullyConsumedShipment.recordId,
          });
          const correctionKey = randomUUID();
          const transactionEntity = target.entities.find((entity) =>
            entity.entityId.endsWith(':entity.inventory_transaction'),
          )!;
          const companionId = deriveInventoryPostingCompanionId({
            capabilityId: FULFILLMENT_CAPABILITY_ID,
            companionFamilyId: transactionEntity.entityId,
            familyId: 'shipment',
            sourceRecordId: unbackedCorrection.recordId,
          });
          const correctionSnapshot = async () =>
            pool.query<{
              accepted_receipts: string;
              companion_rows: string;
              movement_rows: string;
              reservation_quantity: string;
              reservation_revision: string;
              reservation_state: string;
              shipment_revision: string;
              shipment_state: string;
              shipped_quantity: string;
            }>(
              `SELECT
                 (SELECT count(*)::text FROM platform.semantic_operation_receipts
                   WHERE tenant_id=$1 AND environment_id=$2 AND idempotency_key=$7) AS accepted_receipts,
                 (SELECT count(*)::text FROM ${fulfillmentTable(transactionEntity)}
                   WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$8) AS companion_rows,
                 (SELECT count(*)::text FROM ${fulfillmentTable(binding.movement)}
                   WHERE tenant_id=$1 AND environment_id=$2
                     AND ${q(binding.movement.legalEntity!.column)}=$3
                     AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_id'))}=$4::text) AS movement_rows,
                 (SELECT ${q(fulfillmentColumn(binding.reservationBalance, 'reservation_balance_remaining_quantity'))}::text
                    FROM ${fulfillmentTable(binding.reservationBalance)}
                   WHERE tenant_id=$1 AND environment_id=$2
                     AND ${q(fulfillmentRelation(binding, binding.reservationBalance, 'reservation_balance_reservation'))}=$5) AS reservation_quantity,
                 (SELECT revision::text FROM ${fulfillmentTable(binding.reservation)}
                   WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$5) AS reservation_revision,
                 (SELECT ${q(fulfillmentColumn(binding.reservation, 'reservation_state'))}::text
                    FROM ${fulfillmentTable(binding.reservation)}
                   WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$5) AS reservation_state,
                 (SELECT revision::text FROM ${fulfillmentTable(binding.shipment)}
                   WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$4::uuid) AS shipment_revision,
                 (SELECT ${q(fulfillmentColumn(binding.shipment, 'shipment_state'))}::text
                    FROM ${fulfillmentTable(binding.shipment)}
                   WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$4::uuid) AS shipment_state,
                 (SELECT ${q(fulfillmentColumn(binding.shipped, 'sales_order_shipped_shipped_quantity'))}::text
                    FROM ${fulfillmentTable(binding.shipped)}
                   WHERE tenant_id=$1 AND environment_id=$2
                     AND ${q(fulfillmentRelation(binding, binding.shipped, 'sales_order_shipped_order_line'))}=$6) AS shipped_quantity`,
              [
                runtime.identity.tenantId,
                runtime.identity.environmentId,
                legalEntityId,
                unbackedCorrection.recordId,
                correctionReservation.recordId,
                correctionOrderLine.recordId,
                correctionKey,
                companionId,
              ],
            );
          const beforeUnbackedCorrection = await correctionSnapshot();
          await assert.rejects(
            transition(
              'shipment_post',
              unbackedCorrection.recordId,
              unbackedCorrection.revision,
              correctionKey,
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'FULFILLMENT_RESERVATION_SHORTAGE',
            'a correction must not restore reservation coverage above resulting on-hand',
          );
          assert.deepEqual(
            (await correctionSnapshot()).rows,
            beforeUnbackedCorrection.rows,
            'an unbacked correction refusal must roll back every accepted business consequence',
          );
          const failedCorrection = await pool.query<{ failure_code: string }>(
            `SELECT failure_code FROM platform.trust_action_invocations
              WHERE tenant_id=$1 AND environment_id=$2 AND action_id=$3
                AND outcome='FAILED' ORDER BY recorded_at DESC LIMIT 1`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              `${ns}:operation.shipment_post`,
            ],
          );
          assert.deepEqual(failedCorrection.rows, [
            { failure_code: 'FULFILLMENT_RESERVATION_SHORTAGE' },
          ]);

          // Replenish enough that the identical correction is now backed. A
          // failed attempt has no receipt, so the same exact key remains a
          // legitimate retry and must commit once the invariant is satisfied.
          const backingAdjustment = await create('inventory_transaction', {
            actor_id: 'fulfillment-test',
            effective_at: now,
            number: `ADJ-B-BACK-${randomUUID()}`,
            reason_code: 'BACKING',
            reason_narrative: 'Back valid correction coverage',
            recorded_at: now,
            source_id: randomUUID(),
            source_type: 'test',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_adjustment`,
          });
          await create(
            'inventory_transaction_line',
            {
              from_location_id: null,
              item_id: itemId,
              line_number: '1',
              quantity: '2',
              to_location_id: locationB,
              unit_id: 'EA',
            },
            { transaction: backingAdjustment.recordId },
          );
          await transition(
            'inventory_transaction_post',
            backingAdjustment.recordId,
            backingAdjustment.revision,
          );
          await transition(
            'shipment_post',
            unbackedCorrection.recordId,
            unbackedCorrection.revision,
            correctionKey,
          );
          const backedCorrection = await correctionSnapshot();
          assert.equal(backedCorrection.rows[0]!.movement_rows, '1');
          assert.equal(
            fulfillmentQuantity(backedCorrection.rows[0]!.reservation_quantity),
            10n ** 18n,
          );
          assert.equal(backedCorrection.rows[0]!.accepted_receipts, '1');

          await transition(
            'party_role_archive',
            customerRole.recordId,
            customerRole.revision,
          );
          const ineligibleShipment = await shipment('1');
          await assert.rejects(
            transition(
              'shipment_post',
              ineligibleShipment.recordId,
              ineligibleShipment.revision,
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'FULFILLMENT_CUSTOMER_INELIGIBLE',
            'shipment posting must revalidate the current active customer role',
          );
          await create(
            'party_role',
            {
              kind: `${ns}:option.customer`,
              status: `${ns}:option.active`,
            },
            { party: customerPartyId },
            false,
          );
          const shipmentA = await shipment('4');
          const shipmentB = await shipment('4');
          const shipping = await Promise.allSettled([
            transition('shipment_post', shipmentA.recordId, shipmentA.revision),
            transition('shipment_post', shipmentB.recordId, shipmentB.revision),
          ]);
          assert.equal(
            shipping.filter((result) => result.status === 'fulfilled').length,
            1,
            'competing shipments must have exactly one winner',
          );
          assert.ok(
            shipping.some(
              (result) =>
                result.status === 'rejected' &&
                result.reason instanceof InventoryPostingError &&
                result.reason.code === 'FULFILLMENT_RESERVATION_SHORTAGE',
            ),
          );
          const postedShipment =
            shipping[0]!.status === 'fulfilled' ? shipmentA : shipmentB;
          const originalMovement = await pool.query<{ record_id: string }>(
            `SELECT record_id::text FROM ${fulfillmentTable(binding.movement)}
              WHERE tenant_id=$1 AND environment_id=$2
                AND ${q(binding.movement.legalEntity!.column)}=$3
                AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_type'))}='shipment'
                AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_id'))}=$4`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              legalEntityId,
              postedShipment.recordId,
            ],
          );
          assert.equal(originalMovement.rows.length, 1);
          const currentReservation = await pool.query<{ revision: string }>(
            `SELECT revision FROM ${fulfillmentTable(binding.reservation)}
              WHERE tenant_id=$1 AND environment_id=$2
                AND ${q(binding.reservation.legalEntity!.column)}=$3 AND record_id=$4`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              legalEntityId,
              active.recordId,
            ],
          );
          assert.ok(Number(currentReservation.rows[0]!.revision) >= 3);
          const effectsBeforeDelayedReplay = await pool.query<{
            receipts: string;
            succeeded: string;
          }>(
            `SELECT
               (SELECT count(*)::text FROM platform.semantic_operation_receipts
                 WHERE tenant_id=$1 AND environment_id=$2) AS receipts,
               (SELECT count(*)::text FROM platform.trust_action_invocations
                 WHERE tenant_id=$1 AND environment_id=$2 AND outcome='SUCCEEDED') AS succeeded`,
            [runtime.identity.tenantId, runtime.identity.environmentId],
          );
          const delayedReplay = await transition(
            'reservation_reserve',
            active.recordId,
            active.revision,
            activeKey,
          );
          assert.deepEqual(
            delayedReplay.trust,
            activeReserveResult.trust,
            'a delayed exact retry must return the original committed evidence',
          );
          assert.deepEqual(
            await pool
              .query(
                `SELECT
                 (SELECT count(*)::text FROM platform.semantic_operation_receipts
                   WHERE tenant_id=$1 AND environment_id=$2) AS receipts,
                 (SELECT count(*)::text FROM platform.trust_action_invocations
                   WHERE tenant_id=$1 AND environment_id=$2 AND outcome='SUCCEEDED') AS succeeded`,
                [runtime.identity.tenantId, runtime.identity.environmentId],
              )
              .then((result) => result.rows),
            effectsBeforeDelayedReplay.rows,
            'a delayed exact retry must not repeat business or accepted trust effects',
          );
          await assert.rejects(
            transition(
              'reservation_reserve',
              active.recordId,
              active.revision,
              randomUUID(),
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'INVENTORY_TRANSACTION_STATE_CONFLICT',
            'a fresh command with the delayed request revision must remain stale',
          );

          const policyRole = await pool.query<{ role_id: string }>(
            `SELECT role_id FROM platform.current_policy_memberships
              WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3
                AND revoked_at IS NULL`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              runtime.identity.principalId,
            ],
          );
          assert.equal(policyRole.rows.length, 1);
          const reservePermission = `${ns}:permission.reservation_reserve`;
          await pool.query(
            `UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp()
              WHERE tenant_id=$1 AND environment_id=$2 AND role_id=$3 AND permission_id=$4`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              policyRole.rows[0]!.role_id,
              reservePermission,
            ],
          );
          try {
            await assert.rejects(
              transition(
                'reservation_reserve',
                active.recordId,
                active.revision,
                activeKey,
              ),
              SemanticOperationPolicyDeniedError,
              'an exact receipt must not bypass current operation authorization',
            );
          } finally {
            await pool.query(
              `UPDATE platform.current_policy_permission_grants SET revoked_at=NULL
                WHERE tenant_id=$1 AND environment_id=$2 AND role_id=$3 AND permission_id=$4`,
              [
                runtime.identity.tenantId,
                runtime.identity.environmentId,
                policyRole.rows[0]!.role_id,
                reservePermission,
              ],
            );
          }
          await transition(
            'reservation_release',
            active.recordId,
            Number(currentReservation.rows[0]!.revision),
          );
          const releasedInitialShipment = await shipment('1');
          await assert.rejects(
            transition(
              'shipment_post',
              releasedInitialShipment.recordId,
              releasedInitialShipment.revision,
            ),
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === 'FULFILLMENT_RESERVATION_STATE_CONFLICT',
            'an initial shipment must select a currently live reservation',
          );
          const correction = await shipment('2', {
            kind: 'correction',
            reversalOfMovementId: originalMovement.rows[0]!.record_id,
            supersedesShipmentId: postedShipment.recordId,
          });
          await transition(
            'shipment_post',
            correction.recordId,
            correction.revision,
          );
          const releasedReservation = await pool.query<{
            quantity: string;
            state: string;
          }>(
            `SELECT r.${q(fulfillmentColumn(binding.reservation, 'reservation_state'))}::text AS state,
                    b.${q(fulfillmentColumn(binding.reservationBalance, 'reservation_balance_remaining_quantity'))}::text AS quantity
               FROM ${fulfillmentTable(binding.reservation)} r
               JOIN ${fulfillmentTable(binding.reservationBalance)} b
                 ON b.tenant_id=r.tenant_id AND b.environment_id=r.environment_id
                AND b.${q(binding.reservationBalance.legalEntity!.column)}=r.${q(binding.reservation.legalEntity!.column)}
                AND b.${q(fulfillmentRelation(binding, binding.reservationBalance, 'reservation_balance_reservation'))}=r.record_id
              WHERE r.tenant_id=$1 AND r.environment_id=$2
                AND r.${q(binding.reservation.legalEntity!.column)}=$3 AND r.record_id=$4`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              legalEntityId,
              active.recordId,
            ],
          );
          assert.equal(
            releasedReservation.rows[0]!.state,
            `${ns}:option.reservation_state_released`,
            'a linked correction must not silently resurrect a released reservation',
          );
          assert.equal(
            fulfillmentQuantity(releasedReservation.rows[0]!.quantity),
            0n,
            'a linked correction must not restore released reservation coverage',
          );
          const trustEvidence = await pool.query<{
            changes: unknown;
            payload: unknown;
            record_id: string;
          }>(
            `SELECT document.record_id::text,event.payload,document.changes
               FROM platform.trust_business_change_documents document
               JOIN platform.trust_domain_events event
                 ON event.tenant_id=document.tenant_id
                AND event.environment_id=document.environment_id
                AND event.domain_event_id=document.domain_event_id
              WHERE document.action_id=$1 AND document.record_id=$2`,
            [FULFILLMENT_CAPABILITY_ID, postedShipment.recordId],
          );
          assert.equal(trustEvidence.rows.length, 1);
          assert.equal(
            trustEvidence.rows[0]!.record_id,
            postedShipment.recordId,
          );
          for (const evidence of [
            trustEvidence.rows[0]!.changes,
            trustEvidence.rows[0]!.payload,
          ]) {
            const observed = JSON.stringify(evidence);
            assert.match(
              observed,
              /reservationCoverageConsumed|reservationConsequences/u,
            );
            assert.ok(observed.includes(active.recordId));
            assert.ok(observed.includes(line.recordId));
            assert.ok(observed.includes('initial'));
          }

          const client = await pool.connect();
          try {
            await client.query('BEGIN READ ONLY');
            const clean = await reconcileFulfillmentProjections(
              client,
              binding,
              runtime.identity,
            );
            assert.deepEqual(clean.discrepancies, []);
            await client.query('ROLLBACK');
            await client.query(
              `UPDATE ${fulfillmentTable(binding.reservationBalance)}
                  SET ${q(fulfillmentColumn(binding.reservationBalance, 'reservation_balance_remaining_quantity'))}=999
                WHERE tenant_id=$1 AND environment_id=$2
                  AND ${q(fulfillmentRelation(binding, binding.reservationBalance, 'reservation_balance_reservation'))}=$3`,
              [
                runtime.identity.tenantId,
                runtime.identity.environmentId,
                active.recordId,
              ],
            );
            await client.query('BEGIN READ ONLY');
            const divergent = await reconcileFulfillmentProjections(
              client,
              binding,
              runtime.identity,
            );
            assert.equal(
              divergent.discrepancies.length,
              1,
              'reconciliation must detect a tampered reservation quantity',
            );
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
          const materializerPool = new pg.Pool({
            ...connection,
            user: 'north_star_module_materializer',
          });
          const runtimePool = new pg.Pool({
            ...connection,
            user: 'north_star_module_runtime',
          });
          try {
            const materializer = new PostgresModuleStorageMaterializer(
              materializerPool,
              runtimePool,
            );
            const rebuildContext = await new AuthenticatedRequestEntryAdapter(
              async () => runtime.identity,
            ).enter({});
            const repaired =
              await materializer.rebuildFulfillmentProjections(rebuildContext);
            assert.ok(repaired >= 2);
          } finally {
            await Promise.all([materializerPool.end(), runtimePool.end()]);
          }
          const discrepancy = await pool.query<{ total: string }>(
            `SELECT count(*)::text AS total
               FROM north_star_internal.inventory_projection_discrepancies
              WHERE projection_entity_id=$1`,
            [binding.reservationBalance.entityId],
          );
          assert.equal(discrepancy.rows[0]!.total, '1');
          console.log(
            'FULFILLMENT_CRITICAL_CONTROL competingReservation=one-winner competingShipment=one-winner adjustmentReduction=refused transferReduction=refused crossLocationOrderBound=refused staleRevision=refused exactRetry=replayed conflictingRetry=refused auditConsequences=explicit reconciliation=read-only repair=discrepancy-first',
          );
        } finally {
          await app.close();
        }
      },
    );
  },
);

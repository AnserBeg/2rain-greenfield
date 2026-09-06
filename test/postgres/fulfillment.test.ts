import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import {
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_CAPABILITY_ID,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  FULFILLMENT_CAPABILITY_ID,
  fulfillmentBinding,
  fulfillmentColumn,
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

          await create(
            'party_role',
            {
              kind: `${ns}:option.customer`,
              status: `${ns}:option.active`,
            },
            { party: customerPartyId },
            false,
          );
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
              { order_line: line.recordId },
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
          const inactive = active === first ? second : first;
          const replay = await transition(
            'reservation_reserve',
            active.recordId,
            active.revision,
            activeKey,
          );
          assert.equal(replay.outcome, 'succeeded');
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
          );

          const shipment = async (quantity: string) => {
            const header = await create(
              'shipment',
              {
                effective_at: now,
                external_reference: randomUUID(),
                kind: `${ns}:option.shipment_kind_initial`,
                location_id: locationA,
                number: `SHP-${randomUUID()}`,
                reason_code: 'SHIP',
                reason_narrative: 'Competing shipment',
                state: `${ns}:option.shipment_state_draft`,
              },
              { order: order.recordId, supersedes: null },
            );
            await create(
              'shipment_line',
              {
                item_id: itemId,
                line_number: '1',
                quantity,
                reversal_of_movement_id: null,
                unit_id: 'EA',
              },
              {
                order_line: line.recordId,
                reservation: active.recordId,
                shipment: header.recordId,
              },
            );
            return header;
          };
          const shipmentA = await shipment('4');
          const shipmentB = await shipment('4');
          const shipping = await Promise.allSettled([
            transition('shipment_post', shipmentA.recordId, shipmentA.revision),
            transition('shipment_post', shipmentB.recordId, shipmentB.revision),
          ]);
          assert.equal(
            shipping.filter((result) => result.status === 'fulfilled').length,
            1,
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

          const binding = fulfillmentBinding(target)!;
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
                WHERE tenant_id=$1 AND environment_id=$2`,
              [runtime.identity.tenantId, runtime.identity.environmentId],
            );
            await client.query('BEGIN READ ONLY');
            const divergent = await reconcileFulfillmentProjections(
              client,
              binding,
              runtime.identity,
            );
            assert.equal(divergent.discrepancies.length, 1);
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

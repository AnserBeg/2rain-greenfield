import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  RECEIVING_CAPABILITY_ID,
  RECEIVING_CAPABILITY_VERSION,
  quoteReceiptIdentifier as q,
  receiptBinding,
  receiptColumn,
  receiptTable,
  receivedIdentity,
  type VendorReturnCommand,
} from '../../packages/postgres-provider/src/goods-receipt.js';
import {
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  InventoryPostingError,
  PostgresInventoryPostingService,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import { reconcileReceivedQuantities } from '../../packages/postgres-provider/src/received-quantity-projection.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  parsePinnedOperationCatalog,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import { governedStorageTargetArtifact } from '../helpers/governed-storage-target.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

/**
 * RETURNS (ruling R-A), the vendor-return posting family. Each subtest works
 * on its own purchase order line, so a mutation of one claim's production
 * text reds exactly the subtests that exercise it (test/evidence/RETURNS
 * .expected-red.json).
 */
const ns = 'northstar.app';
const legalEntityId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const supplierPartyId = '71000000-0000-4000-8000-000000000001';
const itemId = '71000000-0000-4000-8000-000000000011';
const locationA = '71000000-0000-4000-8000-000000000021';
const barrierNamespace = 7_218;
const barrierKey = 31;

test(
  'vendor returns lower what a line received, never below zero, serialized per order and read back before commit',
  // Seven claims over one composed application, as order-pages runs its
  // pages over one: the bound order-pages already declares.
  { timeout: 600_000 },
  async (t) => {
    await withEphemeralPostgres(
      'vendor-returns',
      async ({ connection, pool }) => {
        const app = await startComposedApplication({
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          port: 0,
          tenantSlug: 'vendor-returns',
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
            recordId: string = randomUUID(),
          ) => {
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
          const storageArtifact = await governedStorageTargetArtifact();
          const target = storageArtifact.payload;
          const binding = receiptBinding(target)!;
          assert.ok(binding.vendorReturn && binding.vendorReturnLine);
          const m = binding.movement;
          const movementColumn = (name: string) =>
            q(receiptColumn(m, `inventory_movement_${name}`));

          /** Stock no order received, so a refusal is the bound's, not stock's. */
          const adjust = async (quantity: string, locationId: string) => {
            // A stock document names itself as its posting source, and the
            // server numbers it (INVENTORY-PARITY).
            const document = randomUUID();
            const stock = await create(
              'inventory_transaction',
              {
                actor_id: 'vendor-return-test',
                effective_at: now,
                reason_code: 'SETUP',
                reason_narrative: 'Vendor return stock',
                recorded_at: now,
                source_id: document,
                source_type: 'inventoryTransaction',
                state: `${ns}:option.inventory_transaction_state_draft`,
                type: `${ns}:option.inventory_transaction_type_adjustment`,
              },
              {},
              true,
              document,
            );
            await create(
              'inventory_transaction_line',
              {
                from_location_id: null,
                item_id: itemId,
                line_number: '1',
                quantity,
                to_location_id: locationId,
                unit_id: 'EA',
              },
              { transaction: stock.recordId },
            );
            await transition(
              'inventory_transaction_post',
              stock.recordId,
              stock.revision,
            );
          };
          const locationB = (
            await create(
              'location',
              {
                code: `VRT-${randomUUID().slice(0, 8)}`,
                name: 'Supplier returns cage',
                type: `${ns}:option.warehouse`,
              },
              {},
              false,
            )
          ).recordId;
          await adjust('50', locationA);
          await adjust('50', locationB);

          /** A released purchase order whose one line orders five units. */
          const purchased = async (label: string) => {
            const order = await create('purchase_order', {
              supplier_party_id: supplierPartyId,
              order_date: now,
              expected_date: null,
              currency: 'CAD',
              notes: label,
            });
            const line = await create(
              'purchase_order_line',
              {
                line_number: '1',
                item_id: itemId,
                ordered_quantity: '5',
                unit_price: '10',
              },
              { order: order.recordId },
            );
            assert.equal(
              (
                await transition(
                  'purchase_order_release',
                  order.recordId,
                  order.revision,
                )
              ).outcome,
              'succeeded',
            );
            return { order: order.recordId, line: line.recordId };
          };
          /** A posted receipt of one line; a correction names its movement. */
          const receive = async (
            purchase: { order: string; line: string },
            quantity: string,
            locationId: string,
            correcting?: { receiptId: string; movementId: string },
          ) => {
            const header = await create(
              'goods_receipt',
              {
                state: `${ns}:option.goods_receipt_state_draft`,
                kind: `${ns}:option.goods_receipt_kind_${correcting ? 'reversal' : 'initial'}`,
                effective_at: now,
                location_id: locationId,
                reason_code: correcting ? 'REVERSE' : 'RECEIVE',
                reason_narrative: 'Vendor return proof',
              },
              {
                order: purchase.order,
                supersedes: correcting?.receiptId ?? null,
              },
            );
            await create(
              'goods_receipt_line',
              {
                line_number: '1',
                item_id: itemId,
                quantity,
                unit_id: 'EA',
                cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
                unit_cost: null,
                currency: null,
                reversal_of_movement_id: correcting?.movementId ?? null,
              },
              { receipt: header.recordId, order_line: purchase.line },
            );
            return {
              ...header,
              result: await transition(
                'goods_receipt_post',
                header.recordId,
                header.revision,
              ),
            };
          };
          /** A draft vendor return of one line; `quantity` is what goes back. */
          const draftReturn = async (
            purchase: { order: string; line: string },
            quantity: string,
            locationId: string,
          ) => {
            const header = await create(
              'vendor_return',
              {
                state: `${ns}:option.vendor_return_state_draft`,
                effective_at: now,
                location_id: locationId,
                reason_code: 'DEFECTIVE',
                // The posting configuration requires code and narrative, as
                // the Return to vendor task does.
                reason_narrative: 'Cracked housings',
              },
              { order: purchase.order },
            );
            const returnLine = await create(
              'vendor_return_line',
              {
                line_number: '1',
                item_id: itemId,
                quantity,
                unit_id: 'EA',
              },
              { return: header.recordId, order_line: purchase.line },
            );
            return { ...header, lineId: returnLine.recordId };
          };
          const post = (draft: { recordId: string; revision: number }) =>
            transition('vendor_return_post', draft.recordId, draft.revision);
          const movementsOf = async (sourceType: string, sourceId: string) =>
            (
              await pool.query<{
                id: string;
                location: string;
                quantity: string;
                role: string;
                line: string;
              }>(
                `SELECT record_id::text AS id,
                      ${movementColumn('location_id')} AS location,
                      ${movementColumn('quantity_delta')}::text AS quantity,
                      ${movementColumn('posting_role')} AS role,
                      ${movementColumn('source_line')} AS line
                 FROM ${receiptTable(m)}
                WHERE tenant_id=$1 AND environment_id=$2
                  AND ${movementColumn('source_type')}=$3
                  AND ${movementColumn('source_id')}=$4
                ORDER BY record_id`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  sourceType,
                  sourceId,
                ],
              )
            ).rows;
          const received = async (orderLineId: string) =>
            (
              await pool.query<{ quantity: string; archived: boolean }>(
                `SELECT ${q(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))}::numeric(38,0)::text AS quantity,
                      archived_at IS NOT NULL AS archived
                 FROM ${receiptTable(binding.received)}
                WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  receivedIdentity(
                    runtime.identity,
                    legalEntityId,
                    orderLineId,
                  ),
                ],
              )
            ).rows[0];
          const onHand = async (locationId: string) =>
            (
              await pool.query<{ quantity: string }>(
                `SELECT coalesce(sum(${movementColumn('quantity_delta')}),0)::numeric(38,0)::text AS quantity
                 FROM ${receiptTable(m)}
                WHERE tenant_id=$1 AND environment_id=$2
                  AND ${movementColumn('item_id')}=$3
                  AND ${movementColumn('location_id')}=$4`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  itemId,
                  locationId,
                ],
              )
            ).rows[0]!.quantity;
          const refusal =
            (code: string, details?: Record<string, string>) =>
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === code &&
              (details === undefined ||
                Object.entries(details).every(
                  ([key, value]) => error.details[key] === value,
                ));
          const reconcile = async () => {
            const client = await pool.connect();
            try {
              await client.query('BEGIN READ ONLY');
              return (
                await reconcileReceivedQuantities(
                  client,
                  binding,
                  runtime.identity,
                )
              ).discrepancies;
            } finally {
              await client.query('ROLLBACK');
              client.release();
            }
          };

          await t.test(
            'V1 a vendor return of more than the line received is refused inside the posting with its operands and writes nothing',
            async () => {
              const purchase = await purchased('V1 over-return');
              await receive(purchase, '5', locationA);
              const draft = await draftReturn(purchase, '6', locationA);
              await assert.rejects(
                post(draft),
                refusal('VENDOR_RETURN_QUANTITY_OUT_OF_BOUNDS', {
                  orderLineId: purchase.line,
                  receivedBefore: '5',
                  attemptedQuantity: '-6',
                }),
                'sending back six of five received units must be refused with its operands',
              );
              assert.deepEqual(
                await movementsOf('vendorReturn', draft.recordId),
                [],
              );
              assert.equal((await received(purchase.line))?.quantity, '5');
            },
          );

          await t.test(
            'V2 a vendor return lowers what the line received and reopens it; a receipt reversal cannot take back returned units',
            async () => {
              const purchase = await purchased('V2 net received');
              const receipt = await receive(purchase, '5', locationA);
              const before = await onHand(locationA);
              const draft = await draftReturn(purchase, '2', locationA);
              assert.equal((await post(draft)).outcome, 'succeeded');
              assert.equal(
                (await received(purchase.line))?.quantity,
                '3',
                'received must fall by the two units sent back',
              );
              assert.equal(await onHand(locationA), String(Number(before) - 2));
              const [receiptMovement] = await movementsOf(
                'goodsReceipt',
                receipt.recordId,
              );
              assert.ok(receiptMovement);
              // Reversing the receipt would take received below zero: the two
              // returned units are no longer there to un-receive.
              await assert.rejects(
                receive(purchase, '-5', locationA, {
                  receiptId: receipt.recordId,
                  movementId: receiptMovement.id,
                }).then((value) => value.result),
                refusal('RECEIPT_QUANTITY_OUT_OF_BOUNDS'),
                'a receipt reversal below the returned units must be refused',
              );
              // The line reopened: two more arrive as an ordinary receipt (a
              // replacement), and nothing beyond what was ordered.
              assert.equal(
                (await receive(purchase, '2', locationA)).result.outcome,
                'succeeded',
              );
              assert.equal((await received(purchase.line))?.quantity, '5');
              await assert.rejects(
                receive(purchase, '1', locationA).then((value) => value.result),
                refusal('RECEIPT_QUANTITY_OUT_OF_BOUNDS'),
                'the replacement fills the order; a sixth unit is refused',
              );
            },
          );

          await t.test(
            'V3 reconciliation counts a vendor return: the received row equals the ledger',
            async () => {
              const purchase = await purchased('V3 reconcile');
              await receive(purchase, '5', locationA);
              assert.equal(
                (await post(await draftReturn(purchase, '2', locationA)))
                  .outcome,
                'succeeded',
              );
              assert.deepEqual(
                await reconcile(),
                [],
                'read-only reconciliation reports no received discrepancy after a vendor return',
              );
            },
          );

          await t.test(
            'V4 destroying and rebuilding the received rows reproduces a returned line net of its return',
            async () => {
              const purchase = await purchased('V4 rebuild');
              await receive(purchase, '5', locationA);
              assert.equal(
                (await post(await draftReturn(purchase, '2', locationA)))
                  .outcome,
                'succeeded',
              );
              await pool.query(
                `UPDATE ${receiptTable(binding.received)} SET archived_at=transaction_timestamp()
                WHERE tenant_id=$1 AND environment_id=$2`,
                [runtime.identity.tenantId, runtime.identity.environmentId],
              );
              const materializerPool = new pg.Pool({
                ...connection,
                user: 'north_star_module_materializer',
              });
              const modulePool = new pg.Pool({
                ...connection,
                user: 'north_star_module_runtime',
              });
              try {
                const context = await new AuthenticatedRequestEntryAdapter(
                  async () => runtime.identity,
                ).enter({});
                assert.ok(
                  (await new PostgresModuleStorageMaterializer(
                    materializerPool,
                    modulePool,
                  ).rebuildReceivedQuantities(context)) >= 1,
                );
              } finally {
                await Promise.all([materializerPool.end(), modulePool.end()]);
              }
              assert.deepEqual(await received(purchase.line), {
                quantity: '3',
                archived: false,
              });
            },
          );

          await t.test(
            'V5 two concurrent vendor returns of one line from two locations serialize on the order: exactly one commits',
            async () => {
              const purchase = await purchased('V5 concurrent returns');
              await receive(purchase, '5', locationA);
              const fromA = await draftReturn(purchase, '3', locationA);
              const fromB = await draftReturn(purchase, '3', locationB);
              const table = receiptTable(binding.vendorReturn!);
              await pool.query(
                `CREATE FUNCTION public.vendor_returns_wait_for_race()
                 RETURNS trigger LANGUAGE plpgsql AS $body$
                 BEGIN
                   PERFORM pg_advisory_xact_lock(${String(barrierNamespace)}, ${String(barrierKey)});
                   RETURN NEW;
                 END
                 $body$;
               CREATE TRIGGER vendor_returns_wait_for_race
                 BEFORE UPDATE ON ${table}
                 FOR EACH ROW EXECUTE FUNCTION public.vendor_returns_wait_for_race()`,
              );
              const blocker = await pool.connect();
              let open = false;
              try {
                await blocker.query('BEGIN');
                open = true;
                await blocker.query('SELECT pg_advisory_xact_lock($1, $2)', [
                  barrierNamespace,
                  barrierKey,
                ]);
                const blockerPid = (
                  await blocker.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid',
                  )
                ).rows[0]!.pid;
                const waitingOn = async (holder: number) => {
                  const deadline = Date.now() + 10_000;
                  while (Date.now() < deadline) {
                    const found = await pool.query<{ pid: number }>(
                      `SELECT pid FROM pg_catalog.pg_stat_activity
                      WHERE wait_event_type='Lock'
                        AND $1::integer = ANY(pg_catalog.pg_blocking_pids(pid))
                      ORDER BY pid LIMIT 1`,
                      [holder],
                    );
                    if (found.rows[0]) return found.rows[0].pid;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                  }
                  throw new Error(
                    `no posting waited on backend ${String(holder)}`,
                  );
                };
                const settle = (promise: Promise<unknown>) =>
                  promise.then(
                    () => ({ ok: true as const }),
                    (error: unknown) => ({ ok: false as const, error }),
                  );
                // The first parks at its own posted-state write, after its
                // bound and movement, holding the order's row locks.
                const first = settle(post(fromA));
                const firstPid = await waitingOn(blockerPid);
                // The second shares no stock lock with it: it must wait on the
                // first before it reads what the line has received.
                const second = settle(post(fromB));
                await waitingOn(firstPid);
                await blocker.query('COMMIT');
                open = false;
                const outcomes = [await first, await second];
                assert.equal(
                  outcomes.filter((outcome) => outcome.ok).length,
                  1,
                  `exactly one of two concurrent vendor returns of three against five received may commit: ${JSON.stringify(outcomes.map((outcome) => (outcome.ok ? 'committed' : String((outcome.error as Error).message))))}`,
                );
                const refused = outcomes.find((outcome) => !outcome.ok);
                assert.ok(
                  refused &&
                    !refused.ok &&
                    refusal('VENDOR_RETURN_QUANTITY_OUT_OF_BOUNDS', {
                      receivedBefore: '2',
                      attemptedQuantity: '-3',
                    })(refused.error),
                  'the later return reads the earlier one and is refused by the bound',
                );
                assert.equal((await received(purchase.line))?.quantity, '2');
              } finally {
                if (open) await blocker.query('ROLLBACK');
                blocker.release();
                await pool.query(
                  `DROP TRIGGER IF EXISTS vendor_returns_wait_for_race ON ${table};
                 DROP FUNCTION IF EXISTS public.vendor_returns_wait_for_race()`,
                );
              }
            },
          );

          await t.test(
            'V6 a posted vendor return writes the return, its companion transaction and one movement, each read back',
            async () => {
              const purchase = await purchased('V6 read-back');
              await receive(purchase, '5', locationA);
              const draft = await draftReturn(purchase, '2', locationB);
              const posted = await post(draft);
              assert.equal(posted.outcome, 'succeeded');
              assert.equal(
                posted.readBack?.values[`${ns}:field.vendor_return_state`],
                `${ns}:option.vendor_return_state_posted`,
              );
              assert.match(
                String(
                  posted.readBack?.values[`${ns}:field.vendor_return_number`],
                ),
                /^VRT-\d{6,}$/u,
              );
              const [movement, ...extra] = await movementsOf(
                'vendorReturn',
                draft.recordId,
              );
              assert.deepEqual(extra, []);
              // Any active location is a valid source (ruling R-C): the goods
              // went back from B though they were received at A.
              assert.equal(movement?.quantity, '-2.000000000000000000');
              assert.equal(movement?.location, locationB);
              assert.equal(movement?.line, draft.lineId);
              assert.equal(
                movement?.role,
                `${ns}:option.inventory_posting_role_vendor_return`,
              );
              const transaction = target.entities.find((entity) =>
                entity.entityId.endsWith(':entity.inventory_transaction'),
              )!;
              const column = (suffix: string) =>
                transaction.columns.find((entry) =>
                  entry.canonicalFieldId.endsWith(
                    `:field.inventory_transaction_${suffix}`,
                  ),
                )!.physicalName;
              const companion = await pool.query<{ type: string }>(
                `SELECT ${q(column('type'))} AS type FROM ${receiptTable(transaction)}
                WHERE tenant_id=$1 AND environment_id=$2
                  AND ${q(column('source_id'))}=$3`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  draft.recordId,
                ],
              );
              assert.deepEqual(companion.rows, [
                {
                  type: `${ns}:option.inventory_transaction_type_vendor_return`,
                },
              ]);
            },
          );

          await t.test(
            'V7 the same key with a changed vendor return conflicts; a duplicate delivery posts once',
            async () => {
              const purchase = await purchased('V7 replay');
              await receive(purchase, '5', locationA);
              const draft = await draftReturn(purchase, '2', locationA);
              const key = randomUUID();
              const posted = await transition(
                'vendor_return_post',
                draft.recordId,
                draft.revision,
                key,
              );
              assert.equal(posted.outcome, 'succeeded');
              const duplicate = await transition(
                'vendor_return_post',
                draft.recordId,
                draft.revision,
                key,
              );
              assert.deepEqual(duplicate.trust, posted.trust);
              assert.equal(
                (await movementsOf('vendorReturn', draft.recordId)).length,
                1,
              );
              const invocation = await pool.query<{
                channel: VendorReturnCommand['channel'];
                policy_version: string;
                policy_evaluator_version: string;
              }>(
                `SELECT channel, policy_version, policy_evaluator_version
                 FROM platform.trust_action_invocations
                WHERE tenant_id=$1 AND environment_id=$2 AND invocation_id=$3`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  posted.trust!.invocationId,
                ],
              );
              const header = (
                await pool.query<Record<string, unknown>>(
                  `SELECT * FROM ${receiptTable(binding.vendorReturn!)}
                  WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`,
                  [
                    runtime.identity.tenantId,
                    runtime.identity.environmentId,
                    draft.recordId,
                  ],
                )
              ).rows[0]!;
              const value = (name: string) =>
                header[
                  receiptColumn(binding.vendorReturn!, `vendor_return_${name}`)
                ];
              const command = (quantity: string): VendorReturnCommand => ({
                authorization: {
                  decision: 'ALLOW',
                  evaluatorVersion:
                    invocation.rows[0]!.policy_evaluator_version,
                  policyVersion: invocation.rows[0]!.policy_version,
                },
                channel: invocation.rows[0]!.channel,
                effectiveAt: (value('effective_at') as Date).toISOString(),
                idempotencyKey: key,
                legalEntityId,
                sourceId: draft.recordId,
                sourceRevision: draft.revision,
                sourceType: 'vendorReturn',
                stockDimensionSetVersion: 'v1',
                returnNumber: String(value('number')),
                orderId: purchase.order,
                locationId: locationA,
                reason: { code: 'DEFECTIVE', narrative: 'Cracked housings' },
                lines: [
                  {
                    returnLineId: draft.lineId,
                    orderLineId: purchase.line,
                    sourceLine: '1',
                    itemId,
                    unitId: 'EA',
                    quantityDelta: quantity,
                  },
                ],
              });
              const directPool = new pg.Pool({
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
                  directPool,
                  {
                    capabilityId: RECEIVING_CAPABILITY_ID,
                    capabilityVersion: RECEIVING_CAPABILITY_VERSION,
                    dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
                    releaseContentHash: runtime.releaseRoot,
                    releaseId: runtime.activeReleaseId,
                    storageTarget: target,
                    storageTargetContentHash: storageArtifact.contentHash,
                  },
                  { currentInstant: () => new Date().toISOString() },
                );
                const replay = await service.postVendorReturn(
                  context,
                  actor,
                  command('-2'),
                );
                assert.equal(replay.replayed, true);
                await assert.rejects(
                  service.postVendorReturn(context, actor, command('-3')),
                  refusal('INVENTORY_POSTING_IDEMPOTENCY_CONFLICT'),
                  'the same key with a changed vendor return quantity must conflict',
                );
                // A retry under a later policy revision: the gateway checks
                // current grants first, and the digest is computed from the
                // recorded invocation's own policy evidence, so it replays.
                const later = command('-2');
                const retried = await service.postVendorReturn(context, actor, {
                  ...later,
                  authorization: {
                    ...later.authorization,
                    policyVersion: `${later.authorization.policyVersion}+later`,
                  },
                });
                assert.equal(
                  retried.replayed,
                  true,
                  'a vendor return retry under a later policy revision must replay',
                );
              } finally {
                await directPool.end();
              }
              assert.equal(
                (await movementsOf('vendorReturn', draft.recordId)).length,
                1,
              );
            },
          );
        } finally {
          await app.close();
        }
      },
    );
  },
);

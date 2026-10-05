import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  FULFILLMENT_CAPABILITY_ID,
  FULFILLMENT_CAPABILITY_VERSION,
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentRelation,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
  type CustomerReturnCommand,
} from '../../packages/postgres-provider/src/fulfillment.js';
import {
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  InventoryPostingError,
  PostgresInventoryPostingService,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
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
 * RETURNS (ruling D), the customer-return posting family. Each subtest works
 * on its own shipped order line, so a mutation of one claim's production text
 * reds exactly the subtests that exercise it (test/evidence/RETURNS
 * .expected-red.json).
 */
const ns = 'northstar.app';
const legalEntityId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const customerPartyId = '71000000-0000-4000-8000-000000000001';
const itemId = '71000000-0000-4000-8000-000000000011';
const locationA = '71000000-0000-4000-8000-000000000021';
const barrierNamespace = 7_217;
const barrierKey = 29;

test(
  'customer returns are bounded by what shipped, serialized per order and read back before commit',
  // Seven claims over one composed application, as order-pages runs its
  // pages over one: the bound order-pages already declares.
  { timeout: 600_000 },
  async (t) => {
    await withEphemeralPostgres(
      'customer-returns',
      async ({ connection, pool }) => {
        const app = await startComposedApplication({
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          port: 0,
          tenantSlug: 'customer-returns',
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
          const storageArtifact = await governedStorageTargetArtifact();
          const target = storageArtifact.payload;
          const binding = fulfillmentBinding(target)!;
          assert.ok(binding.customerReturn && binding.customerReturnLine);
          const movementColumn = (name: string) =>
            q(
              fulfillmentColumn(binding.movement, `inventory_movement_${name}`),
            );

          // One customer, stock at the seeded location, and a second location
          // any return may choose (ruling R-C).
          await create(
            'party_role',
            {
              kind: `${ns}:option.customer`,
              status: `${ns}:option.active`,
            },
            { party: customerPartyId },
            false,
          );
          const adjust = async (quantity: string, locationId: string) => {
            const stock = await create('inventory_transaction', {
              actor_id: 'customer-return-test',
              effective_at: now,
              number: `ADJ-RET-${randomUUID()}`,
              reason_code: 'SETUP',
              reason_narrative: 'Customer return stock',
              recorded_at: now,
              source_id: randomUUID(),
              source_type: 'test',
              state: `${ns}:option.inventory_transaction_state_draft`,
              type: `${ns}:option.inventory_transaction_type_adjustment`,
            });
            await create(
              'inventory_transaction_line',
              {
                from_location_id: quantity.startsWith('-') ? locationId : null,
                item_id: itemId,
                line_number: '1',
                quantity,
                to_location_id: quantity.startsWith('-') ? null : locationId,
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
          await adjust('100', locationA);
          const locationB = (
            await create(
              'location',
              {
                code: `RET-${randomUUID().slice(0, 8)}`,
                name: 'Returns bay',
                type: `${ns}:option.warehouse`,
              },
              {},
              false,
            )
          ).recordId;

          const shipTo = {
            ship_to_name: 'Receiving dock',
            ship_to_street: '100 Industrial Way',
            ship_to_city: 'Calgary',
            ship_to_region: 'AB',
            ship_to_postal_code: 'T2P 0A1',
            ship_to_country: 'Canada',
          };
          /** A confirmed order whose one line shipped five units from A. */
          const shippedLine = async (label: string) => {
            const order = await create('sales_order', {
              currency: 'CAD',
              customer_party_id: customerPartyId,
              notes: label,
              order_date: now,
              requested_date: now,
              ...shipTo,
            });
            const line = await create(
              'sales_order_line',
              {
                item_id: itemId,
                line_number: '1',
                ordered_quantity: '5',
                unit_id: 'EA',
                unit_price: null,
              },
              { order: order.recordId },
            );
            assert.equal(
              (
                await transition(
                  'sales_order_release',
                  order.recordId,
                  order.revision,
                )
              ).outcome,
              'succeeded',
            );
            const reservation = await create(
              'reservation',
              {
                item_id: itemId,
                location_id: locationA,
                number: `RSV-${randomUUID()}`,
                quantity: '5',
                reason: 'Release unused stock',
                state: `${ns}:option.reservation_state_draft`,
                unit_id: 'EA',
              },
              { order_line: line.recordId },
            );
            await transition(
              'reservation_reserve',
              reservation.recordId,
              reservation.revision,
            );
            const shipment = await create(
              'shipment',
              {
                effective_at: now,
                external_reference: null,
                kind: `${ns}:option.shipment_kind_initial`,
                location_id: locationA,
                reason_code: 'SHIP',
                reason_narrative: label,
                state: `${ns}:option.shipment_state_draft`,
                carrier: 'Carrier',
                shipping_reference_kind: `${ns}:option.shipment_shipping_reference_kind_tracking`,
                shipping_reference: randomUUID().slice(0, 12),
                ...shipTo,
              },
              { order: order.recordId },
            );
            await create(
              'shipment_line',
              {
                item_id: itemId,
                line_number: '1',
                quantity: '5',
                reversal_of_movement_id: null,
                unit_id: 'EA',
              },
              {
                order_line: line.recordId,
                reservation: reservation.recordId,
                shipment: shipment.recordId,
              },
            );
            await transition(
              'shipment_post',
              shipment.recordId,
              shipment.revision,
            );
            return {
              order: order.recordId,
              line: line.recordId,
              reservation: reservation.recordId,
              shipment: shipment.recordId,
            };
          };
          /** A draft return of one line; `quantity` is the signed delta. */
          const draftReturn = async (
            shipped: { order: string; line: string },
            quantity: string,
            locationId: string,
            options: {
              kind?: 'initial' | 'correction' | 'reversal';
              supersedes?: string;
              reversalOf?: string;
              reason?: string;
              notes?: string | null;
            } = {},
          ) => {
            const kind = options.kind ?? 'initial';
            const header = await create(
              'customer_return',
              {
                state: `${ns}:option.customer_return_state_draft`,
                kind: `${ns}:option.customer_return_kind_${kind}`,
                effective_at: now,
                location_id: locationId,
                reason_code: options.reason ?? 'DAMAGED',
                // The composed tenant's posting configuration requires code
                // and narrative, as the Receive return task does.
                reason_narrative: options.notes ?? 'Came back unopened',
              },
              {
                order: shipped.order,
                supersedes: options.supersedes ?? null,
              },
            );
            const returnLine = await create(
              'customer_return_line',
              {
                line_number: '1',
                item_id: itemId,
                quantity,
                unit_id: 'EA',
                reversal_of_movement_id: options.reversalOf ?? null,
              },
              { return: header.recordId, order_line: shipped.line },
            );
            return { ...header, lineId: returnLine.recordId };
          };
          const post = (draft: { recordId: string; revision: number }) =>
            transition('customer_return_post', draft.recordId, draft.revision);
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
                   FROM ${fulfillmentTable(binding.movement)}
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
          const onHand = async (locationId: string) =>
            (
              await pool.query<{ quantity: string }>(
                `SELECT coalesce(sum(${movementColumn('quantity_delta')}),0)::numeric(38,0)::text AS quantity
                   FROM ${fulfillmentTable(binding.movement)}
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
          const rowOf = async (
            entity: NonNullable<typeof binding.customerReturn>,
            recordId: string,
          ) =>
            (
              await pool.query<Record<string, unknown>>(
                `SELECT * FROM ${fulfillmentTable(entity)}
                  WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  recordId,
                ],
              )
            ).rows[0]!;
          const shippedRow = async (orderLineId: string) =>
            (
              await pool.query<{ quantity: string; revision: string }>(
                `SELECT ${q(fulfillmentColumn(binding.shipped, 'sales_order_shipped_shipped_quantity'))}::numeric(38,0)::text AS quantity,
                        revision::text AS revision
                   FROM ${fulfillmentTable(binding.shipped)}
                  WHERE tenant_id=$1 AND environment_id=$2
                    AND ${q(fulfillmentRelation(binding, binding.shipped, 'sales_order_shipped_order_line'))}=$3`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  orderLineId,
                ],
              )
            ).rows[0];
          const refusal =
            (code: string, details?: Record<string, string>) =>
            (error: unknown) =>
              error instanceof InventoryPostingError &&
              error.code === code &&
              (details === undefined ||
                Object.entries(details).every(
                  ([key, value]) => error.details[key] === value,
                ));

          await t.test(
            'B1 an over-return is refused inside the posting with its four operands and writes nothing',
            async () => {
              const shipped = await shippedLine('B1 over-return');
              const draft = await draftReturn(shipped, '6', locationB);
              await assert.rejects(
                post(draft),
                refusal('FULFILLMENT_RETURN_QUANTITY_OUT_OF_BOUNDS', {
                  orderLineId: shipped.line,
                  shippedQuantity: '5',
                  returnedBefore: '0',
                  attemptedQuantity: '6',
                }),
                'returning six of five shipped units must be refused with its operands',
              );
              assert.deepEqual(
                await movementsOf('customerReturn', draft.recordId),
                [],
              );
              const header = await rowOf(
                binding.customerReturn!,
                draft.recordId,
              );
              assert.equal(
                header[
                  fulfillmentColumn(
                    binding.customerReturn!,
                    'customer_return_state',
                  )
                ],
                `${ns}:option.customer_return_state_draft`,
              );
            },
          );

          await t.test(
            'B2 returns count apart from shipments: after 2 of 5 come back, shipped stays 5 and 3 more may return',
            async () => {
              const shipped = await shippedLine('B2 apart from shipped');
              const shippedBefore = await shippedRow(shipped.line);
              const reservationBefore = await rowOf(
                binding.reservation,
                shipped.reservation,
              );
              const [aBefore, bBefore] = [
                await onHand(locationA),
                await onHand(locationB),
              ];
              const first = await draftReturn(shipped, '2', locationB);
              assert.equal((await post(first)).outcome, 'succeeded');
              // The goods are back at the location the return chose.
              assert.equal(
                await onHand(locationB),
                String(Number(bBefore) + 2),
              );
              assert.equal(await onHand(locationA), aBefore);
              // Shipped and the reservation are untouched facts.
              assert.deepEqual(await shippedRow(shipped.line), shippedBefore);
              assert.deepEqual(
                await rowOf(binding.reservation, shipped.reservation),
                reservationBefore,
              );
              // Three shipped units have not come back, so three may.
              const second = await draftReturn(shipped, '3', locationB);
              assert.equal((await post(second)).outcome, 'succeeded');
              assert.deepEqual(await shippedRow(shipped.line), shippedBefore);
            },
          );

          await t.test(
            'B3 a shipment reversal cannot take back units the customer has returned',
            async () => {
              const shipped = await shippedLine('B3 shipment guard');
              const returned = await draftReturn(shipped, '2', locationB);
              assert.equal((await post(returned)).outcome, 'succeeded');
              const [shipmentMovement] = await movementsOf(
                'shipment',
                shipped.shipment,
              );
              assert.ok(shipmentMovement);
              const correction = async (
                kind: 'correction' | 'reversal',
                quantity: string,
              ) => {
                const header = await create(
                  'shipment',
                  {
                    effective_at: now,
                    external_reference: null,
                    kind: `${ns}:option.shipment_kind_${kind}`,
                    location_id: locationA,
                    reason_code: 'CORRECT',
                    reason_narrative: 'Shipped in error',
                    state: `${ns}:option.shipment_state_draft`,
                    ...shipTo,
                  },
                  { order: shipped.order, supersedes: shipped.shipment },
                );
                await create(
                  'shipment_line',
                  {
                    item_id: itemId,
                    line_number: '1',
                    quantity,
                    reversal_of_movement_id: shipmentMovement.id,
                    unit_id: 'EA',
                  },
                  {
                    order_line: shipped.line,
                    reservation: shipped.reservation,
                    shipment: header.recordId,
                  },
                );
                return header;
              };
              const reversal = await correction('reversal', '5');
              await assert.rejects(
                transition(
                  'shipment_post',
                  reversal.recordId,
                  reversal.revision,
                ),
                refusal('FULFILLMENT_SHIPMENT_BELOW_RETURNED', {
                  orderLineId: shipped.line,
                  shippedAfter: '0',
                  returned: '2',
                }),
                'a shipment reversal below the two returned units must be refused',
              );
              // Taking back three of five still leaves the two returned.
              const partial = await correction('correction', '3');
              assert.equal(
                (
                  await transition(
                    'shipment_post',
                    partial.recordId,
                    partial.revision,
                  )
                ).outcome,
                'succeeded',
              );
              assert.equal((await shippedRow(shipped.line))?.quantity, '2');
            },
          );

          await t.test(
            'B4 two concurrent returns of one line into two locations serialize on the order: exactly one commits',
            async () => {
              const shipped = await shippedLine('B4 concurrent returns');
              const intoA = await draftReturn(shipped, '3', locationA);
              const intoB = await draftReturn(shipped, '3', locationB);
              const table = fulfillmentTable(binding.customerReturn!);
              await pool.query(
                `CREATE FUNCTION public.returns_wait_for_race()
                   RETURNS trigger LANGUAGE plpgsql AS $body$
                   BEGIN
                     PERFORM pg_advisory_xact_lock(${String(barrierNamespace)}, ${String(barrierKey)});
                     RETURN NEW;
                   END
                   $body$;
                 CREATE TRIGGER returns_wait_for_race
                   BEFORE UPDATE ON ${table}
                   FOR EACH ROW EXECUTE FUNCTION public.returns_wait_for_race()`,
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
                // The first return parks at its own posted-state write, after
                // its bound and movements, holding the order's row locks.
                const first = settle(post(intoA));
                const firstPid = await waitingOn(blockerPid);
                // The second shares no stock lock with it: it must wait on the
                // first before it reads what has been returned.
                const second = settle(post(intoB));
                await waitingOn(firstPid);
                await blocker.query('COMMIT');
                open = false;
                const outcomes = [await first, await second];
                assert.equal(
                  outcomes.filter((outcome) => outcome.ok).length,
                  1,
                  `exactly one of two concurrent returns of three against five shipped may commit: ${JSON.stringify(outcomes.map((outcome) => (outcome.ok ? 'committed' : String((outcome.error as Error).message))))}`,
                );
                const refused = outcomes.find((outcome) => !outcome.ok);
                assert.ok(
                  refused &&
                    !refused.ok &&
                    refusal('FULFILLMENT_RETURN_QUANTITY_OUT_OF_BOUNDS', {
                      shippedQuantity: '5',
                      returnedBefore: '3',
                      attemptedQuantity: '3',
                    })(refused.error),
                  'the later return reads the earlier one and is refused by the bound',
                );
              } finally {
                if (open) await blocker.query('ROLLBACK');
                blocker.release();
                await pool.query(
                  `DROP TRIGGER IF EXISTS returns_wait_for_race ON ${table};
                   DROP FUNCTION IF EXISTS public.returns_wait_for_race()`,
                );
              }
            },
          );

          await t.test(
            'B5 a correction or reversal takes back only movements of the return it names',
            async () => {
              const shipped = await shippedLine('B5 compensation');
              const original = await draftReturn(shipped, '2', locationB);
              assert.equal((await post(original)).outcome, 'succeeded');
              const other = await draftReturn(shipped, '1', locationB);
              assert.equal((await post(other)).outcome, 'succeeded');
              const [originalMovement] = await movementsOf(
                'customerReturn',
                original.recordId,
              );
              const [otherMovement] = await movementsOf(
                'customerReturn',
                other.recordId,
              );
              const [shipmentMovement] = await movementsOf(
                'shipment',
                shipped.shipment,
              );
              assert.ok(originalMovement && otherMovement && shipmentMovement);
              const namingShipment = await draftReturn(
                shipped,
                '-1',
                locationB,
                {
                  kind: 'correction',
                  supersedes: original.recordId,
                  reversalOf: shipmentMovement.id,
                },
              );
              await assert.rejects(
                post(namingShipment),
                refusal('FULFILLMENT_RETURN_INVALID'),
                'a correction naming a shipment movement must be refused',
              );
              const namingOtherReturn = await draftReturn(
                shipped,
                '-1',
                locationB,
                {
                  kind: 'correction',
                  supersedes: original.recordId,
                  reversalOf: otherMovement.id,
                },
              );
              await assert.rejects(
                post(namingOtherReturn),
                refusal('FULFILLMENT_RETURN_INVALID'),
                'a correction naming another return of the order must be refused',
              );
              // The reversal "Reverse return" writes: every movement the
              // return still adds, at exactly that quantity, where it went.
              const reversal = await draftReturn(shipped, '-2', locationB, {
                kind: 'reversal',
                supersedes: original.recordId,
                reversalOf: originalMovement.id,
              });
              assert.equal((await post(reversal)).outcome, 'succeeded');
              const [reversalMovement] = await movementsOf(
                'customerReturn',
                reversal.recordId,
              );
              assert.equal(reversalMovement?.quantity, '-2.000000000000000000');
              assert.equal(reversalMovement?.location, locationB);
              // One unit of the other return is still back, so taking one
              // more out keeps the line's net returned at zero: only the
              // compensation rule can refuse it.
              const again = await draftReturn(shipped, '-1', locationB, {
                kind: 'correction',
                supersedes: original.recordId,
                reversalOf: originalMovement.id,
              });
              await assert.rejects(
                post(again),
                refusal('FULFILLMENT_RETURN_INVALID'),
                'a reversed return has nothing left to take back',
              );
            },
          );

          await t.test(
            'B6 a posted return writes the return, its companion transaction and one movement, each read back',
            async () => {
              const shipped = await shippedLine('B6 read-back');
              const draft = await draftReturn(shipped, '2', locationB, {
                reason: 'WRONG_ITEM',
                notes: 'Customer ordered blue',
              });
              const posted = await post(draft);
              assert.equal(posted.outcome, 'succeeded');
              assert.equal(
                posted.readBack?.values[`${ns}:field.customer_return_state`],
                `${ns}:option.customer_return_state_posted`,
              );
              const header = await rowOf(
                binding.customerReturn!,
                draft.recordId,
              );
              assert.equal(Number(header.revision), draft.revision + 1);
              assert.match(
                String(
                  header[
                    fulfillmentColumn(
                      binding.customerReturn!,
                      'customer_return_number',
                    )
                  ],
                ),
                /^RMA-\d{6,}$/u,
              );
              const [movement, ...extra] = await movementsOf(
                'customerReturn',
                draft.recordId,
              );
              assert.deepEqual(extra, []);
              assert.equal(movement?.quantity, '2.000000000000000000');
              assert.equal(movement?.location, locationB);
              assert.equal(movement?.line, draft.lineId);
              assert.equal(
                movement?.role,
                `${ns}:option.inventory_posting_role_customer_return`,
              );
              const companion = await pool.query<{ type: string }>(
                `SELECT ${q(
                  target.entities
                    .find((entity) =>
                      entity.entityId.endsWith(':entity.inventory_transaction'),
                    )!
                    .columns.find((column) =>
                      column.canonicalFieldId.endsWith(
                        ':field.inventory_transaction_type',
                      ),
                    )!.physicalName,
                )} AS type
                   FROM ${fulfillmentTable(
                     target.entities.find((entity) =>
                       entity.entityId.endsWith(
                         ':entity.inventory_transaction',
                       ),
                     )!,
                   )}
                  WHERE tenant_id=$1 AND environment_id=$2
                    AND ${q(
                      target.entities
                        .find((entity) =>
                          entity.entityId.endsWith(
                            ':entity.inventory_transaction',
                          ),
                        )!
                        .columns.find((column) =>
                          column.canonicalFieldId.endsWith(
                            ':field.inventory_transaction_source_id',
                          ),
                        )!.physicalName,
                    )}=$3`,
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  draft.recordId,
                ],
              );
              assert.deepEqual(companion.rows, [
                {
                  type: `${ns}:option.inventory_transaction_type_customer_return`,
                },
              ]);
            },
          );

          await t.test(
            'B7 the same key with a changed return conflicts; a duplicate delivery posts once',
            async () => {
              const shipped = await shippedLine('B7 replay');
              const draft = await draftReturn(shipped, '2', locationB);
              const key = randomUUID();
              const posted = await transition(
                'customer_return_post',
                draft.recordId,
                draft.revision,
                key,
              );
              assert.equal(posted.outcome, 'succeeded');
              const duplicate = await transition(
                'customer_return_post',
                draft.recordId,
                draft.revision,
                key,
              );
              assert.deepEqual(duplicate.trust, posted.trust);
              assert.equal(
                (await movementsOf('customerReturn', draft.recordId)).length,
                1,
              );
              // The recorded invocation's own channel and policy evidence, so
              // the replay below differs from the stored input only where the
              // test changes it.
              const invocation = await pool.query<{
                channel: CustomerReturnCommand['channel'];
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
              const header = await rowOf(
                binding.customerReturn!,
                draft.recordId,
              );
              const column = (name: string) =>
                header[
                  fulfillmentColumn(
                    binding.customerReturn!,
                    `customer_return_${name}`,
                  )
                ];
              const command = (quantity: string): CustomerReturnCommand => ({
                authorization: {
                  decision: 'ALLOW',
                  evaluatorVersion:
                    invocation.rows[0]!.policy_evaluator_version,
                  policyVersion: invocation.rows[0]!.policy_version,
                },
                channel: invocation.rows[0]!.channel,
                effectiveAt: (column('effective_at') as Date).toISOString(),
                idempotencyKey: key,
                legalEntityId,
                sourceId: draft.recordId,
                sourceRevision: draft.revision,
                sourceType: 'customerReturn',
                stockDimensionSetVersion: 'v1',
                kind: 'initial',
                returnNumber: String(column('number')),
                orderId: shipped.order,
                locationId: locationB,
                supersedesReturnId: null,
                reason: { code: 'DAMAGED', narrative: 'Came back unopened' },
                lines: [
                  {
                    returnLineId: draft.lineId,
                    orderLineId: shipped.line,
                    sourceLine: '1',
                    itemId,
                    unitId: 'EA',
                    quantityDelta: quantity,
                    reversalOfMovementId: null,
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
                    capabilityId: FULFILLMENT_CAPABILITY_ID,
                    capabilityVersion: FULFILLMENT_CAPABILITY_VERSION,
                    dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
                    releaseContentHash: runtime.releaseRoot,
                    releaseId: runtime.activeReleaseId,
                    storageTarget: target,
                    storageTargetContentHash: storageArtifact.contentHash,
                  },
                  { currentInstant: () => new Date().toISOString() },
                );
                const replay = await service.postCustomerReturn(
                  context,
                  actor,
                  command('2'),
                );
                assert.equal(replay.replayed, true);
                await assert.rejects(
                  service.postCustomerReturn(context, actor, command('3')),
                  refusal('INVENTORY_POSTING_IDEMPOTENCY_CONFLICT'),
                  'the same key with a changed return quantity must conflict',
                );
                // A retry under a later policy revision: the gateway checks
                // current grants first, and the digest is computed from the
                // recorded invocation's own policy evidence, so it replays.
                const later = command('2');
                const retried = await service.postCustomerReturn(
                  context,
                  actor,
                  {
                    ...later,
                    authorization: {
                      ...later.authorization,
                      policyVersion: `${later.authorization.policyVersion}+later`,
                    },
                  },
                );
                assert.equal(
                  retried.replayed,
                  true,
                  'a return retry under a later policy revision must replay',
                );
              } finally {
                await directPool.end();
              }
              assert.equal(
                (await movementsOf('customerReturn', draft.recordId)).length,
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

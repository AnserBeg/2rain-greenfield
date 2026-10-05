import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  startComposedApplication,
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
} from '../../apps/api/src/composition-root.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import {
  receiptBinding,
  receiptColumn,
  receiptTable,
  quoteReceiptIdentifier as q,
} from '../../packages/postgres-provider/src/goods-receipt.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationPolicyDeniedError,
  MalformedSemanticOperationRequestError,
  parsePinnedOperationCatalog,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';

const ns = 'northstar.app';
const entityA = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const item = '71000000-0000-4000-8000-000000000011';
const location = '71000000-0000-4000-8000-000000000021';
const routes = [
  'initial',
  'correction',
  'reversal',
  'amend',
  'close',
  'reopen',
] as const;
type Route = (typeof routes)[number];

test(
  'receiving real authorization: every route denies before effects, isolates scope and preserves committed truth',
  { timeout: 300_000 },
  async (t) => {
    await withEphemeralPostgres(
      'receipt-auth-correction',
      async ({ connection, pool }) => {
        const app = await startComposedApplication({
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          port: 0,
          tenantSlug: 'receipt-auth-correction',
        });
        const runtime = app.runtime;
        const identity = [
          runtime.identity.tenantId,
          runtime.identity.environmentId,
        ];
        const binding = receiptBinding(await governedStorageTarget())!;
        const entityB = randomUUID();
        const role = (
          await pool.query<{ role_id: string }>(
            `SELECT role_id FROM platform.current_policy_roles WHERE tenant_id=$1 AND environment_id=$2 AND role_key='local-demo-full-release'`,
            identity,
          )
        ).rows[0]!.role_id;
        const invoke = (
          local: string,
          input: ImmutableJsonValue,
          key = randomUUID(),
        ) =>
          runtime.entry.run({ headers: {} }, (view) => {
            const operationId = `${ns}:operation.${local}`;
            return runtime.operationGateway.invoke(
              view,
              {
                schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                operationId,
                input,
                idempotencyKey: key,
                confirmationGrant:
                  parsePinnedOperationCatalog(
                    view.projections.operation.payload,
                  ).find((definition) => definition.operationId === operationId)
                    ?.confirmation === 'humanRequired'
                    ? runtime.operationMediation.issueConfirmationGrant(
                        view,
                        operationId,
                        input,
                      )
                    : null,
              },
              runtime.operationMediation.issueInvocation(view, 'UI'),
            );
          });
        async function create(
          local: string,
          values: Record<string, ImmutableJsonValue>,
          scope: string | null = entityA,
          relations: Record<string, string | null> = {},
        ) {
          const recordId = randomUUID();
          const result = await invoke(`${local}_create`, {
            recordId,
            ...(scope ? { legalEntityId: scope } : {}),
            values: Object.fromEntries(
              Object.entries(values).map(([key, value]) => [
                `${ns}:field.${local}_${key}`,
                value,
              ]),
            ),
            relations: Object.fromEntries(
              Object.entries(relations).map(([key, value]) => [
                `${ns}:relation.${local}_${key}`,
                value,
              ]),
            ),
          });
          assert.equal(result.outcome, 'succeeded');
          return recordId;
        }
        async function receipt(
          order: string,
          line: string,
          scope: string,
          kind: 'initial' | 'correction' | 'reversal',
          original?: { receipt: string; movement: string },
        ) {
          // The receipt number is assigned by the server (RCV-000001).
          const id = await create(
            'goods_receipt',
            {
              state: `${ns}:option.goods_receipt_state_draft`,
              kind: `${ns}:option.goods_receipt_kind_${kind}`,
              effective_at: new Date().toISOString(),
              location_id: location,
              reason_code: 'DELIVERY',
              reason_narrative: 'RECEIPT-AUTH-SECRET',
            },
            scope,
            { order, ...(original ? { supersedes: original.receipt } : {}) },
          );
          await create(
            'goods_receipt_line',
            {
              line_number: '1',
              item_id: item,
              quantity:
                kind === 'initial' ? '3' : kind === 'correction' ? '-1' : '-3',
              unit_id: 'EA',
              cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
              unit_cost: null,
              currency: null,
              reversal_of_movement_id: original?.movement ?? null,
            },
            scope,
            { receipt: id, order_line: line },
          );
          return id;
        }
        async function seed(route: Route, scope: string = entityA) {
          const order = await create(
            'purchase_order',
            {
              supplier_party_id: 'receiving-auth-supplier',
              order_date: new Date().toISOString(),
              currency: 'CAD',
              expected_date: null,
              notes: 'RECEIPT-AUTH-SECRET',
            },
            scope,
          );
          let line = '';
          if (!['close', 'reopen'].includes(route))
            line = await create(
              'purchase_order_line',
              {
                line_number: '1',
                item_id: item,
                ordered_quantity: '5',
                unit_price: null,
              },
              scope,
              { order },
            );
          await invoke('purchase_order_release', {
            recordId: order,
            expectedRevision: 1,
          });
          if (route === 'close' || route === 'reopen') {
            if (route === 'reopen')
              await invoke('purchase_order_close', {
                recordId: order,
                expectedRevision: 2,
              });
            return {
              local: `purchase_order_${route}`,
              recordId: order,
              expectedRevision: route === 'close' ? 2 : 3,
              entity: binding.order,
              readPermission: `${ns}:permission.purchase_order_read`,
            };
          }
          if (route === 'amend') {
            await create(
              'purchase_order_amendment',
              {
                number: `AUTH-AM-${randomUUID()}`,
                line_revision: '1',
                quantity: '6',
                reason: 'RECEIPT-AUTH-SECRET',
              },
              scope,
              { order_line: line },
            );
            return {
              local: 'purchase_order_line_amend',
              recordId: line,
              expectedRevision: 1,
              entity: binding.orderLine,
              readPermission: `${ns}:permission.purchase_order_line_read`,
            };
          }
          const originalId = await receipt(order, line, scope, 'initial');
          let recordId = originalId;
          if (route !== 'initial') {
            await invoke('goods_receipt_post', {
              recordId: originalId,
              expectedRevision: 1,
            });
            const movement = (
              await pool.query<{ record_id: string }>(
                `SELECT record_id FROM ${receiptTable(binding.movement)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(receiptColumn(binding.movement, 'inventory_movement_source_id'))}=$3`,
                [...identity, originalId],
              )
            ).rows[0]!.record_id;
            recordId = await receipt(order, line, scope, route, {
              receipt: originalId,
              movement,
            });
          }
          return {
            local: 'goods_receipt_post',
            recordId,
            expectedRevision: 1,
            entity: binding.receipt,
            readPermission: `${ns}:permission.goods_receipt_read`,
          };
        }
        const grant = (permission: string, revoked: boolean) =>
          pool.query(
            `UPDATE platform.current_policy_permission_grants SET revoked_at=CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND environment_id=$2 AND role_id=$3 AND permission_id=$4`,
            [...identity, role, permission, revoked],
          );
        const membership = (scope: string | null) =>
          pool.query(
            `UPDATE platform.current_policy_memberships SET legal_entity_id=$5 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND role_id=$4`,
            [...identity, runtime.identity.principalId, role, scope],
          );
        async function effects() {
          const rows = [];
          for (const entity of binding.target.entities)
            rows.push(
              (
                await pool.query(
                  `SELECT to_jsonb(t) AS row FROM ${receiptTable(entity)} t WHERE tenant_id=$1 AND environment_id=$2 ORDER BY record_id`,
                  identity,
                )
              ).rows,
            );
          rows.push(
            (
              await pool.query(
                `SELECT to_jsonb(t) AS row FROM platform.semantic_operation_receipts t WHERE tenant_id=$1 AND environment_id=$2 ORDER BY invocation_id`,
                identity,
              )
            ).rows,
          );
          return rows;
        }
        async function denials() {
          return (
            await pool.query<{
              invocation_id: string;
              failure_code: string;
              metadata: unknown;
              policy_inputs: unknown;
            }>(
              `SELECT invocation_id,failure_code,metadata,policy_inputs FROM platform.trust_action_invocations WHERE tenant_id=$1 AND environment_id=$2 AND outcome='DENIED' ORDER BY recorded_at,invocation_id`,
              identity,
            )
          ).rows;
        }
        async function assertDenial(
          before: Awaited<ReturnType<typeof denials>>,
          code: string,
          recordId: string,
        ) {
          const after = await denials();
          const added = after.filter(
            (row) =>
              !before.some((old) => old.invocation_id === row.invocation_id),
          );
          assert.equal(
            added.length,
            1,
            'one denied invocation, not duplicate operation/query denials',
          );
          assert.equal(added[0]!.failure_code, code);
          const payload = JSON.stringify([
            added[0]!.metadata,
            added[0]!.policy_inputs,
          ]);
          assert.ok(!payload.includes(recordId));
          assert.ok(!payload.includes('RECEIPT-AUTH-SECRET'));
        }
        const revision = async (draft: Awaited<ReturnType<typeof seed>>) =>
          Number(
            (
              await pool.query(
                `SELECT revision FROM ${receiptTable(draft.entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`,
                [...identity, draft.recordId],
              )
            ).rows[0]!.revision,
          );
        const run = (
          draft: Awaited<ReturnType<typeof seed>>,
          key = randomUUID(),
          extra = {},
        ) =>
          invoke(
            draft.local,
            {
              recordId: draft.recordId,
              expectedRevision: draft.expectedRevision,
              ...extra,
            },
            key,
          );
        try {
          await pool.query(
            `SELECT platform.provision_inventory_scope($1,$2,$3,'AUTH-B','AUTH B','UTC','00:00:00',$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
            [...identity, entityB, runtime.releaseRoot],
          );
          // The platform scope and its business master are separate persisted facts.
          await invoke('legal_entity_create', {
            recordId: entityB,
            values: {
              [`${ns}:field.legal_entity_code`]: 'AUTH-B',
              [`${ns}:field.legal_entity_name`]: 'AUTH B',
              [`${ns}:field.legal_entity_is_default`]: false,
              [`${ns}:field.legal_entity_status`]: `${ns}:option.legal_entity_status_active`,
            },
          });
          for (const route of routes) {
            await t.test(route, async (caseTest) => {
              const draft = await seed(route);
              try {
                const foreign = await seed(route, entityB);
                const inputKey = randomUUID();
                const before = await effects();
                const deniedBefore = await denials();
                await grant(draft.readPermission, true);
                await assert.rejects(
                  run(draft),
                  SemanticOperationPolicyDeniedError,
                );
                assert.deepEqual(
                  await effects(),
                  before,
                  `${route}: missing read must prevent every business effect`,
                );
                await assertDenial(
                  deniedBefore,
                  'SEMANTIC_OPERATION_POLICY_DENIED',
                  draft.recordId,
                );
                await grant(draft.readPermission, false);
                await membership(entityA);
                const foreignBefore = await effects();
                const foreignDenials = await denials();
                await assert.rejects(
                  run(foreign),
                  SemanticOperationPolicyDeniedError,
                );
                await assertDenial(
                  foreignDenials,
                  'SEMANTIC_OPERATION_POLICY_DENIED',
                  foreign.recordId,
                );
                await assert.rejects(
                  run(foreign, randomUUID(), { legalEntityId: entityA }),
                  MalformedSemanticOperationRequestError,
                );
                assert.deepEqual(
                  await effects(),
                  foreignBefore,
                  `${route}: B and forged A scope have no effects`,
                );

                // Revocation is committed atomically with this command's receipt. The
                // subsequent real query/evaluator must withhold data, not negate commit.
                await pool.query(`CREATE FUNCTION platform.receipt_auth_revoke_read() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
            IF NEW.idempotency_key = TG_ARGV[0]::uuid THEN UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp() WHERE tenant_id=NEW.tenant_id AND environment_id=NEW.environment_id AND role_id=TG_ARGV[2]::uuid AND permission_id=TG_ARGV[1]; END IF; RETURN NEW; END $$`);
                // Arguments are closed route IDs and a generated UUID, not user SQL.
                await pool.query(
                  `CREATE TRIGGER receipt_auth_revoke_read AFTER INSERT ON platform.semantic_operation_receipts FOR EACH ROW EXECUTE FUNCTION platform.receipt_auth_revoke_read('${inputKey}','${draft.readPermission}','${role}')`,
                );
                const commitDenials = await denials();
                let committed;
                try {
                  committed = await run(draft, inputKey);
                } finally {
                  await pool.query(
                    'DROP TRIGGER receipt_auth_revoke_read ON platform.semantic_operation_receipts',
                  );
                  await pool.query(
                    'DROP FUNCTION platform.receipt_auth_revoke_read()',
                  );
                }
                assert.equal(committed.outcome, 'succeeded');
                assert.equal(committed.readBack, null);
                assert.ok(committed.trust);
                assert.equal(await revision(draft), draft.expectedRevision + 1);
                const persisted = (
                  await pool.query(
                    `SELECT invocation_id,change_document_id,domain_event_id,outbox_id FROM platform.semantic_operation_receipts WHERE tenant_id=$1 AND environment_id=$2 AND idempotency_key=$3`,
                    [...identity, inputKey],
                  )
                ).rows;
                assert.deepEqual(persisted, [
                  {
                    invocation_id: committed.trust.invocationId,
                    change_document_id: committed.trust.changeDocumentId,
                    domain_event_id: committed.trust.domainEventId,
                    outbox_id: committed.trust.outboxId,
                  },
                ]);
                await assertDenial(
                  commitDenials,
                  'SEMANTIC_QUERY_POLICY_DENIED',
                  draft.recordId,
                );
                await grant(draft.readPermission, false);
                const afterCommit = await effects();
                const replay = await run(draft, inputKey);
                assert.equal(replay.outcome, 'succeeded');
                assert.equal(
                  replay.readBack?.revision,
                  draft.expectedRevision + 1,
                );
                assert.deepEqual(replay.trust, committed.trust);
                assert.deepEqual(
                  await effects(),
                  afterCommit,
                  `${route}: identical retry has no new effects`,
                );
                const unrelated = caseTest.mock.method(
                  runtime.queryGateway,
                  'invoke',
                  async () => {
                    throw new Error('unrelated read-back failure');
                  },
                );
                try {
                  await assert.rejects(
                    run(draft, inputKey),
                    { code: 'SEMANTIC_OPERATION_EXECUTION_FAILED' },
                    'only a typed policy denial may yield committed success without data',
                  );
                } finally {
                  unrelated.mock.restore();
                }
                assert.deepEqual(await effects(), afterCommit);
              } finally {
                await grant(draft.readPermission, false);
                await membership(null);
              }
            });
          }
        } finally {
          for (const permission of [
            'goods_receipt',
            'purchase_order',
            'purchase_order_line',
          ])
            await grant(`${ns}:permission.${permission}_read`, false);
          await membership(null);
          await app.close();
        }
      },
    );
  },
);

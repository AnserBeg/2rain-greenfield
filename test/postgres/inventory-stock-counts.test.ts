import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  executeStockCountChange,
  stockCountBinding,
} from '../../packages/postgres-provider/src/stock-count-route.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  QUERY_BOUNDARY_PERMISSION_ID,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  registeredQueryFromPinnedView,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  OPERATION_BOUNDARY_PERMISSION_ID,
  SEMANTIC_OPERATION_POLICY_EVALUATOR_VERSION,
  SemanticOperationPolicyDeniedError,
  parsePinnedOperationCatalog,
  type RegisteredCapabilityOperationDefinition,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import {
  LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
  trustedContextForRequestRuntimeView,
  type ImmutableJsonValue,
} from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
/**
 * The demo seed's Vancouver warehouse: a second location, holding nothing
 * until the test finds stock there.
 */
const VANCOUVER_WAREHOUSE = '71000000-0000-4000-8000-000000000023';

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

const countField = (local: string) => `${ns}:field.stock_count_${local}`;
const lineField = (local: string) => `${ns}:field.stock_count_line_${local}`;
const state = (local: string) => `${ns}:option.stock_count_state_${local}`;
const kind = (local: string) => `${ns}:option.stock_count_kind_${local}`;
const refusal = (code: string, message?: RegExp) => (error: unknown) => {
  assert.ok(
    error instanceof InventoryPostingError,
    `expected ${code}, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  if (message) assert.match(error.message, message);
  return true;
};
const moduleRefusal = (code: string) => (error: unknown) => {
  assert.ok(
    error instanceof ModuleRuntimeInterpreterError,
    `expected ${code}, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  return true;
};
const commandDenied = (action: string) => (error: unknown) =>
  error instanceof SemanticOperationPolicyDeniedError &&
  error.operationId === `${ns}:operation.stock_count_${action}`;

/** A stored exact decimal as a person reads it: `-2`, not `-2.000…`. */
function canonical(value: unknown): string {
  const text = String(value);
  return /^-?\d+\.\d+$/u.test(text)
    ? text.replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1')
    : text;
}

/**
 * Independent facts, read from PostgreSQL directly: on-hand of an item at a
 * location, a count's state and lines, the movements naming a source, and
 * the companion transactions the kernel writes.
 */
async function storage(fixture: Fixture, companyId: string = fixture.scope) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const column = (local: string, name: string) =>
    fulfillmentColumn(entity(local), name);
  const scope = [
    fixture.app.runtime.identity.tenantId,
    fixture.app.runtime.identity.environmentId,
    companyId,
  ];
  const balance = entity('posted_stock_balance');
  const onHand = async (location: string) =>
    new Map(
      (
        await fixture.pool.query<{ item: string; quantity: string }>(
          `SELECT ${column('posted_stock_balance', 'posted_stock_balance_item_id')} AS item,
                  ${column('posted_stock_balance', 'posted_stock_balance_posted_quantity')}::text AS quantity
             FROM ${fulfillmentTable(balance)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${balance.legalEntity!.column} = $3
              AND ${column('posted_stock_balance', 'posted_stock_balance_location_id')} = $4
              AND ${balance.archive.archivedAtColumn} IS NULL`,
          [...scope, location],
        )
      ).rows.map((row) => [row.item, canonical(row.quantity)]),
    );
  const count = entity('stock_count');
  const stored = async (recordId: string) =>
    (
      await fixture.pool.query<Record<string, unknown>>(
        `SELECT ${count.optimisticRevision.column}::integer AS revision,
                ${column('stock_count', 'stock_count_state')} AS state,
                ${column('stock_count', 'stock_count_number')} AS number,
                to_char(${column('stock_count', 'stock_count_counted_at')} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "countedAt"
           FROM ${fulfillmentTable(count)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${count.legalEntity!.column} = $3
            AND ${count.recordIdentity.column} = $4`,
        [...scope, recordId],
      )
    ).rows[0];
  const line = entity('stock_count_line');
  const session = target.relations.find(
    (value) => value.relationId === `${ns}:relation.stock_count_line_session`,
  )!.relationColumn.physicalName;
  const lines = async (recordId: string) =>
    (
      await fixture.pool.query<{
        recordId: string;
        revision: number;
        line: string;
        item: string;
        physical: string | null;
        expected: string;
        counted: string;
        variance: string;
        reversal: string | null;
      }>(
        `SELECT ${line.recordIdentity.column}::text AS "recordId",
                ${line.optimisticRevision.column}::integer AS revision,
                ${column('stock_count_line', 'stock_count_line_line_number')}::text AS line,
                ${column('stock_count_line', 'stock_count_line_item_id')} AS item,
                ${column('stock_count_line', 'stock_count_line_physical_quantity')}::text AS physical,
                ${column('stock_count_line', 'stock_count_line_expected_quantity')}::text AS expected,
                ${column('stock_count_line', 'stock_count_line_counted_quantity')}::text AS counted,
                ${column('stock_count_line', 'stock_count_line_variance_quantity')}::text AS variance,
                ${column('stock_count_line', 'stock_count_line_reversal_of_movement_id')} AS reversal
           FROM ${fulfillmentTable(line)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${line.legalEntity!.column} = $3
            AND ${session} = $4
            AND ${line.archive.archivedAtColumn} IS NULL
          ORDER BY ${column('stock_count_line', 'stock_count_line_line_number')}`,
        [...scope, recordId],
      )
    ).rows.map((row) => ({
      ...row,
      physical: row.physical === null ? null : canonical(row.physical),
      expected: canonical(row.expected),
      counted: canonical(row.counted),
      variance: canonical(row.variance),
    }));
  const movement = entity('inventory_movement');
  const movements = async (source: string) =>
    (
      await fixture.pool.query<{
        movementId: string;
        item: string;
        location: string;
        delta: string;
        role: string;
      }>(
        `SELECT ${movement.recordIdentity.column}::text AS "movementId",
                ${column('inventory_movement', 'inventory_movement_item_id')} AS item,
                ${column('inventory_movement', 'inventory_movement_location_id')} AS location,
                ${column('inventory_movement', 'inventory_movement_quantity_delta')}::text AS delta,
                ${column('inventory_movement', 'inventory_movement_posting_role')} AS role
           FROM ${fulfillmentTable(movement)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${movement.legalEntity!.column} = $3
            AND ${column('inventory_movement', 'inventory_movement_source_id')} = $4
          ORDER BY ${column('inventory_movement', 'inventory_movement_source_line')}`,
        [...scope, source],
      )
    ).rows.map((row) => ({
      ...row,
      delta: canonical(row.delta),
      role: row.role.split(':option.inventory_posting_role_')[1]!,
    }));
  const transaction = entity('inventory_transaction');
  const companions = async () =>
    (
      await fixture.pool.query<{ recordId: string; number: string }>(
        `SELECT ${transaction.recordIdentity.column}::text AS "recordId",
                ${column('inventory_transaction', 'inventory_transaction_number')} AS number
           FROM ${fulfillmentTable(transaction)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${transaction.legalEntity!.column} = $3
            AND ${column('inventory_transaction', 'inventory_transaction_number')} LIKE 'SC-%'`,
        scope,
      )
    ).rows;
  return { companions, lines, movements, onHand, stored };
}

/** One page of a declared list query, in the fixture's company. */
async function listed(
  fixture: Fixture,
  query: string,
  extra: Record<string, ImmutableJsonValue> = {},
  companyId: string = fixture.scope,
) {
  return fixture.app.runtime.entry.run({ headers: {} }, (view) =>
    fixture.app.runtime.queryGateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: `${ns}:query.${query}`,
      arguments: {
        includeArchived: false,
        [`${ns}:parameter.${query}_legal_entity_scope`]: companyId,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: 100,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: '',
          sort: [],
          ...extra,
        },
      },
    }),
  );
}

/**
 * The count as the editor and the record page drive it: the header with the
 * values its first save writes, each command on the posting route, each line
 * written as the editor writes one.
 */
function counts(fixture: Fixture, companyId: string = fixture.scope) {
  const create = async (
    location: string,
    options: {
      readonly kind?: string;
      readonly mode?: 'blind' | 'open';
      readonly narrative?: string;
      readonly state?: string;
      readonly supersedes?: string;
      readonly type?: 'annual' | 'correction' | 'cycle' | 'opening';
    } = {},
  ) =>
    fixture.create(
      'stock_count',
      {
        kind: kind(options.kind ?? 'initial'),
        state: state(options.state ?? 'draft'),
        location_id: location,
        counted_at: new Date().toISOString(),
        reason_code: 'PHYSICAL_COUNT',
        reason_narrative:
          options.narrative ?? 'Cycle count by the stock count test',
        count_type: `${ns}:option.stock_count_count_type_${options.type ?? 'cycle'}`,
        counting_mode: `${ns}:option.stock_count_counting_mode_${options.mode ?? 'open'}`,
      },
      options.supersedes ? { supersedes: options.supersedes } : {},
      true,
      randomUUID(),
      companyId,
    );
  const command = (
    action: 'cancel' | 'post' | 'reopen' | 'review' | 'start',
    recordId: string,
    expectedRevision: number,
    key = randomUUID(),
  ) =>
    fixture.invoke(
      `stock_count_${action}`,
      { recordId, expectedRevision },
      key,
    );
  const enter = (
    line: { readonly recordId: unknown; readonly revision: unknown },
    physical: string,
  ) =>
    fixture.invoke('stock_count_line_update', {
      recordId: String(line.recordId),
      expectedRevision: Number(line.revision),
      patch: { [lineField('physical_quantity')]: physical },
    });
  const found = (
    count: string,
    item: string,
    lineNumber: string,
    physical: string,
  ) =>
    fixture.create(
      'stock_count_line',
      {
        line_number: lineNumber,
        item_id: item,
        unit_id: 'EA',
        physical_quantity: physical,
        // The editor's line create values: Review replaces all three.
        expected_quantity: '0',
        counted_quantity: '0',
        variance_quantity: '0',
      },
      { session: count },
      true,
      randomUUID(),
      companyId,
    );
  return { command, create, enter, found };
}

async function buyerPolicy(fixture: Fixture) {
  const { tenantId, environmentId, principalId } = fixture.app.runtime.identity;
  const [buyer] = (
    await fixture.pool.query<{ role_id: string }>(
      `SELECT role_id FROM platform.current_policy_roles
      WHERE tenant_id = $1 AND environment_id = $2 AND role_key = 'local-demo-full-release'`,
      [tenantId, environmentId],
    )
  ).rows;
  assert.ok(buyer);
  const role = [tenantId, environmentId, buyer.role_id];
  return {
    scope: (companyId: string) =>
      fixture.pool.query(
        `UPDATE platform.current_policy_memberships SET legal_entity_id = $5
        WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3 AND principal_id = $4`,
        [...role, principalId, companyId],
      ),
    only: (permissions: string[]) =>
      fixture.pool.query(
        `UPDATE platform.current_policy_permission_grants SET revoked_at = clock_timestamp()
        WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3
          AND permission_id <> ALL($4::text[])`,
        [...role, permissions],
      ),
    revoke: (action: string, revoked: boolean) =>
      fixture.pool.query(
        `UPDATE platform.current_policy_permission_grants
          SET revoked_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END
        WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3 AND permission_id = $4`,
        [...role, `${ns}:permission.stock_count_${action}`, revoked],
      ),
  };
}

const countLinesOf = (recordId: string) => ({
  parentScope: {
    relationId: `${ns}:relation.stock_count_line_session`,
    recordId,
  },
});

test(
  'STOCK-COUNTS: a blind counter can enter counts but cannot read the book or supervise',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const count = counts(fixture);
      const created = await count.create(fixture.location, { mode: 'blind' });
      const started = await count.command(
        'start',
        created.recordId,
        created.revision,
      );
      const parent = countLinesOf(created.recordId);
      const lineIn = (rows: Awaited<ReturnType<typeof listed>>['records']) => {
        const line = rows.find(
          (row) => row.values[lineField('item_id')] === fixture.item,
        );
        assert.ok(line);
        return line;
      };
      assert.ok(
        (await listed(fixture, 'posted_stock_balance_list')).records.length,
      );
      const before = lineIn(
        (await listed(fixture, 'stock_count_count_lines', parent)).records,
      );
      assert.equal(
        before.values[`${ns}:metric.count_book`],
        null,
        'the blind projection hides the book even when stock read is granted',
      );

      const buyer = await buyerPolicy(fixture);
      await buyer.scope(fixture.scope);
      await buyer.only([
        QUERY_BOUNDARY_PERMISSION_ID,
        OPERATION_BOUNDARY_PERMISSION_ID,
        LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
        ...[
          'stock_count_read',
          'stock_count_line_read',
          'stock_count_line_update',
        ].map((name) => `${ns}:permission.${name}`),
      ]);
      const line = lineIn(
        (await listed(fixture, 'stock_count_count_lines', parent)).records,
      );
      assert.equal(line.values[`${ns}:metric.count_book`], null);
      assert.equal(line.values[`${ns}:metric.count_variance`], null);
      const saved = await count.enter(line, '2');
      assert.equal(
        canonical(saved.readBack?.values[lineField('physical_quantity')]),
        '2',
      );
      for (const query of [
        'posted_stock_balance_list',
        'item_stock_positions',
      ]) {
        await assert.rejects(
          listed(
            fixture,
            query,
            query === 'item_stock_positions'
              ? {
                  fieldFilters: [
                    {
                      fieldId: `${ns}:field.posted_stock_balance_item_id`,
                      value: fixture.item,
                    },
                  ],
                }
              : {},
          ),
          (error: unknown) =>
            error instanceof SemanticQueryPolicyDeniedError &&
            error.queryId === `${ns}:query.${query}`,
        );
      }
      const revision = started.readBack!.revision;
      await assert.rejects(
        count.command('review', created.recordId, revision),
        SemanticOperationPolicyDeniedError,
      );
      const manager = (action: string, expectedRevision: number) =>
        fixture.invoke(
          `stock_count_${action}`,
          { recordId: created.recordId, expectedRevision },
          randomUUID(),
          'manager',
        );
      for (const other of (
        await listed(fixture, 'stock_count_count_lines', parent)
      ).records)
        if (other.recordId !== line.recordId) await count.enter(other, '0');
      const reviewed = await manager('review', revision);
      await assert.rejects(
        count.command('reopen', created.recordId, reviewed.readBack!.revision),
        SemanticOperationPolicyDeniedError,
      );
      await manager('reopen', reviewed.readBack!.revision);
      const recount = lineIn(
        (await listed(fixture, 'stock_count_line_list', parent)).records,
      );
      for (const field of [
        'expected_quantity',
        'counted_quantity',
        'variance_quantity',
      ])
        assert.equal(canonical(recount.values[lineField(field)]), '0');
      assert.equal(
        canonical(recount.values[lineField('physical_quantity')]),
        '2',
      );
    });
  },
);

test(
  'STOCK-COUNTS: commands and count-line reads use the stored company within one tenant and environment',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const other = await fixture.create(
        'legal_entity',
        {
          code: 'COUNT-B',
          name: 'Count company B',
          is_default: false,
          status: `${ns}:option.legal_entity_status_active`,
        },
        {},
        false,
      );
      const count = counts(fixture);
      const otherCompany = counts(fixture, other.recordId);
      const foreign = await otherCompany.create(fixture.location, {
        type: 'opening',
      });
      await otherCompany.found(foreign.recordId, fixture.item, '1', '4');
      const home = await count.create(fixture.location);
      const readForeign = await storage(fixture, other.recordId);
      const before = await readForeign.stored(foreign.recordId);
      assert.equal(
        (
          await listed(
            fixture,
            'stock_count_count_lines',
            countLinesOf(foreign.recordId),
            other.recordId,
          )
        ).records.length,
        1,
      );
      const buyer = await buyerPolicy(fixture);
      assert.equal((await buyer.scope(fixture.scope)).rowCount, 1);

      await assert.rejects(
        count.command('start', foreign.recordId, foreign.revision),
        commandDenied('start'),
      );
      await assert.rejects(
        listed(
          fixture,
          'stock_count_count_lines',
          countLinesOf(foreign.recordId),
          other.recordId,
        ),
        SemanticQueryPolicyDeniedError,
      );
      // Even using an authorized scope cannot return the foreign count's lines.
      assert.deepEqual(
        (
          await listed(
            fixture,
            'stock_count_count_lines',
            countLinesOf(foreign.recordId),
          )
        ).records,
        [],
      );
      assert.equal(
        (await count.command('start', home.recordId, home.revision)).outcome,
        'succeeded',
      );
      assert.ok(
        (
          await listed(
            fixture,
            'stock_count_count_lines',
            countLinesOf(home.recordId),
          )
        ).records.length,
      );
      assert.deepEqual(await readForeign.stored(foreign.recordId), before);

      // Isolate execution's locked-row check from the gateway's earlier decision.
      // The stored owner is B while the authorization handed to the route is A.
      const runtime = fixture.app.runtime;
      const binding = stockCountBinding(await governedStorageTarget());
      assert.ok(binding);
      await runtime.entry.run({ headers: {} }, async (view) => {
        const context = trustedContextForRequestRuntimeView(view);
        const input = {
          expectedRevision: foreign.revision,
          recordId: foreign.recordId,
        };
        const definition = parsePinnedOperationCatalog(
          view.projections.operation.payload,
        ).find(
          (operation) =>
            operation.operationId === `${ns}:operation.stock_count_start`,
        );
        assert.equal(definition?.effect.kind, 'registeredCapabilityEffect');
        const readBackDefinition = registeredQueryFromPinnedView(
          view,
          `${ns}:query.stock_count_get`,
        );
        assert.ok(readBackDefinition);
        const actorIssuer = new TrustedActorEnvelopeIssuer({
          async resolve() {
            return {
              approvingHumanId: null,
              delegation: null,
              executionPrincipal: {
                kind: 'HUMAN',
                principalId: context.principalId,
              },
              initiatingHumanId: context.principalId,
              subject: null,
            };
          },
        });
        await assert.rejects(
          executeStockCountChange(
            {
              actorIssuer,
              currentInstant: () => new Date().toISOString(),
              pool: fixture.pool,
              projection: () => {
                throw new Error('Start uses the resolved storage binding');
              },
              queryGateway: runtime.queryGateway,
              releaseId: view.release.releaseId,
              releaseContentHash: view.release.contentHash,
            },
            binding,
            {
              authorization: {
                decisionInput: { legalEntityId: fixture.scope },
                legalEntityReadScopeIds: [fixture.scope],
                readBackArguments: { recordId: input.recordId },
              },
              channel: 'UI',
              context,
              definition: definition as RegisteredCapabilityOperationDefinition,
              idempotencyKey: randomUUID(),
              input,
              inputDigest: 'a'.repeat(64),
              policyVersion: view.entryPolicyVersion,
              policyEvaluatorVersion:
                SEMANTIC_OPERATION_POLICY_EVALUATOR_VERSION,
              readBackDefinition,
              view,
            },
            'start',
            input,
            fixture.scope,
          ),
          refusal(
            'INVENTORY_POSTING_INPUT_INVALID',
            /the count scope changed after authorization/u,
          ),
          'the route must recheck the company under the row lock',
        );
      });
      assert.deepEqual(await readForeign.stored(foreign.recordId), before);
    });
  },
);

for (const [scenario, second, message] of [
  [
    'a repeated product',
    'duplicate',
    /counts a product another line already counts/u,
  ],
  [
    'a negative physical quantity',
    'negative',
    /a physical count is never negative/u,
  ],
] as const) {
  test(
    `STOCK-COUNTS: Review refuses ${scenario}`,
    { timeout: 300_000 },
    async () => {
      await withOrderEntryFixture(async (fixture) => {
        const count = counts(fixture);
        const read = await storage(fixture);
        const created = await count.create(fixture.location, {
          type: 'opening',
        });
        const started = await count.command(
          'start',
          created.recordId,
          created.revision,
        );
        if (second === 'duplicate') {
          await count.found(created.recordId, fixture.item, '1', '2');
          await count.found(created.recordId, fixture.item, '2', '1');
        } else {
          await count.found(created.recordId, fixture.item, '1', '-1');
        }
        const before = await read.lines(created.recordId);
        await assert.rejects(
          count.command('review', created.recordId, started.readBack!.revision),
          refusal('INVENTORY_POSTING_INPUT_INVALID', message),
          `Review must refuse ${scenario}`,
        );
        assert.equal(
          (await read.stored(created.recordId))?.state,
          state('counting'),
        );
        assert.deepEqual(await read.lines(created.recordId), before);
      });
    },
  );
}

test(
  'STOCK-COUNTS: reversal Review refuses a movement missing from the original lines',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const count = counts(fixture);
      const read = await storage(fixture);
      const original = await count.create(VANCOUVER_WAREHOUSE, {
        type: 'opening',
      });
      const started = await count.command(
        'start',
        original.recordId,
        original.revision,
      );
      const line = await count.found(original.recordId, fixture.item, '1', '2');
      const reviewed = await count.command(
        'review',
        original.recordId,
        started.readBack!.revision,
      );
      await count.command(
        'post',
        original.recordId,
        reviewed.readBack!.revision,
      );
      assert.equal((await read.movements(original.recordId)).length, 1);
      // Simulate an incomplete original read-back without changing its ledger.
      const binding = stockCountBinding(await governedStorageTarget());
      assert.ok(binding);
      const archived = await fixture.pool.query(
        `UPDATE ${fulfillmentTable(binding.line)}
          SET ${binding.line.archive.archivedAtColumn} = now()
        WHERE tenant_id = $1 AND environment_id = $2 AND ${binding.legalEntityColumn} = $3
          AND ${binding.line.recordIdentity.column} = $4`,
        [
          fixture.app.runtime.identity.tenantId,
          fixture.app.runtime.identity.environmentId,
          fixture.scope,
          line.recordId,
        ],
      );
      assert.equal(archived.rowCount, 1);

      const reversal = await count.create(VANCOUVER_WAREHOUSE, {
        kind: 'reversal',
        state: 'counting',
        supersedes: original.recordId,
      });
      await assert.rejects(
        count.command('review', reversal.recordId, reversal.revision),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          /the reversed count does not read back as it posted/u,
        ),
        'reversal must cover every original movement',
      );
      assert.equal(
        (await read.stored(reversal.recordId))?.state,
        state('counting'),
      );
      assert.deepEqual(await read.lines(reversal.recordId), []);
    });
  },
);

test(
  'STOCK-COUNTS: each transition refuses when its own permission is absent',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const count = counts(fixture);
      const read = await storage(fixture);
      const buyer = await buyerPolicy(fixture);
      const created = await count.create(fixture.location, { type: 'opening' });
      const attempt = async (
        action: Parameters<typeof count.command>[0],
        revision: number,
        id = created.recordId,
      ) => {
        const before = {
          header: await read.stored(id),
          lines: await read.lines(id),
          movements: await read.movements(id),
        };
        assert.equal((await buyer.revoke(action, true)).rowCount, 1);
        await assert.rejects(
          count.command(action, id, revision),
          commandDenied(action),
          `missing ${action} grant must refuse`,
        );
        assert.deepEqual(
          {
            header: await read.stored(id),
            lines: await read.lines(id),
            movements: await read.movements(id),
          },
          before,
        );
        assert.equal((await buyer.revoke(action, false)).rowCount, 1);
        return count.command(action, id, revision);
      };
      const started = await attempt('start', created.revision);
      await count.found(created.recordId, fixture.item, '1', '2');
      const reviewed = await attempt('review', started.readBack!.revision);
      const reopened = await attempt('reopen', reviewed.readBack!.revision);
      const readyToPost = await count.command(
        'review',
        created.recordId,
        reopened.readBack!.revision,
      );
      await attempt('post', readyToPost.readBack!.revision);
      const draft = await count.create(fixture.location);
      await attempt('cancel', draft.revision, draft.recordId);
    });
  },
);

/**
 * A stock document posted through its own route: one line of the demo item,
 * into `location` when the quantity is positive and out of it when negative,
 * effective at `effectiveAt`.
 */
async function postAdjustment(
  fixture: Fixture,
  input: {
    readonly location: string;
    readonly quantity: string;
    readonly effectiveAt: string;
    readonly reason: string;
    readonly narrative: string;
  },
): Promise<void> {
  const adjustment = randomUUID();
  const negative = input.quantity.startsWith('-');
  const header = await fixture.create(
    'inventory_transaction',
    {
      actor_id: 'stock-count-test',
      effective_at: input.effectiveAt,
      recorded_at: new Date().toISOString(),
      reason_code: input.reason,
      reason_narrative: input.narrative,
      source_type: 'inventoryTransaction',
      source_id: adjustment,
      state: `${ns}:option.inventory_transaction_state_draft`,
      type: `${ns}:option.inventory_transaction_type_adjustment`,
    },
    {},
    true,
    adjustment,
  );
  await fixture.create(
    'inventory_transaction_line',
    {
      from_location_id: negative ? input.location : null,
      to_location_id: negative ? null : input.location,
      item_id: fixture.item,
      line_number: '1',
      quantity: input.quantity,
      unit_id: 'EA',
    },
    { transaction: adjustment },
  );
  await fixture.invoke('inventory_transaction_post', {
    recordId: adjustment,
    expectedRevision: header.revision,
  });
}

test(
  'STOCK-COUNTS: a recount retains physical entries and clears the stored review figures',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const read = await storage(fixture);
      const count = counts(fixture);
      const created = await count.create(fixture.location, { mode: 'blind' });
      const started = await count.command(
        'start',
        created.recordId,
        created.revision,
      );
      const line = (await read.lines(created.recordId)).find(
        (row) => row.item === fixture.item,
      )!;
      await count.enter(line, '2');
      for (const other of await read.lines(created.recordId)) {
        if (other.item !== fixture.item) await count.enter(other, '0');
      }
      const reviewed = await count.command(
        'review',
        created.recordId,
        started.readBack!.revision,
      );
      const frozen = (await read.lines(created.recordId)).find(
        (row) => row.item === fixture.item,
      )!;
      assert.notEqual(frozen.expected, '0');
      assert.equal(frozen.counted, '2');
      assert.notEqual(frozen.variance, '0');

      const reopened = await count.command(
        'reopen',
        created.recordId,
        reviewed.readBack!.revision,
      );
      assert.equal(
        reopened.readBack?.values[countField('state')],
        state('counting'),
      );
      const recount = (await read.lines(created.recordId)).find(
        (row) => row.item === fixture.item,
      )!;
      assert.deepEqual(
        [recount.expected, recount.counted, recount.variance],
        ['0', '0', '0'],
        'reopen clears every stored review figure',
      );
      assert.equal(recount.physical, '2');
      assert.equal(recount.revision, frozen.revision + 1);
      await count.enter(recount, '3');
      await count.command(
        'review',
        created.recordId,
        reopened.readBack!.revision,
      );
      const recounted = (await read.lines(created.recordId)).find(
        (row) => row.item === fixture.item,
      )!;
      assert.equal(recounted.counted, '3');
    });
  },
);

test(
  'STOCK-COUNTS: counting mode is fixed after Start even through a state reset',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const count = counts(fixture);
      const created = await count.create(fixture.location);
      const save = (revision: number, patch: Record<string, string>) =>
        fixture.invoke('stock_count_update', {
          recordId: created.recordId,
          expectedRevision: revision,
          patch,
        });
      const blind = `${ns}:option.stock_count_counting_mode_blind`;
      const open = `${ns}:option.stock_count_counting_mode_open`;
      const draft = await save(created.revision, {
        [countField('counting_mode')]: blind,
      });
      assert.equal(draft.readBack?.values[countField('counting_mode')], blind);
      const started = await count.command(
        'start',
        created.recordId,
        draft.readBack!.revision,
      );
      const revision = started.readBack!.revision;
      await assert.rejects(
        save(revision, { [countField('counting_mode')]: open }),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
        'the mode cannot change during counting',
      );
      await assert.rejects(
        save(revision, { [countField('state')]: state('draft') }),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
        'the header cannot be reset to draft to change the mode',
      );
      const saved = await save(revision, {
        [countField('counting_mode')]: blind,
        [countField('reason_narrative')]: 'Check the adjacent bay again',
      });
      assert.equal(saved.readBack?.values[countField('counting_mode')], blind);
    });
  },
);

for (const [scenario, physical, delta] of [
  ['posts a fractional downward count', '9.5', '-0.5'],
  ['reverses a fractional upward count', '10.5', '0.5'],
] as const) {
  test(`STOCK-COUNTS: ${scenario}`, { timeout: 300_000 }, async () => {
    await withOrderEntryFixture(async (fixture) => {
      const read = await storage(fixture);
      const count = counts(fixture);
      const location = VANCOUVER_WAREHOUSE;
      await postAdjustment(fixture, {
        location,
        quantity: '10',
        effectiveAt: new Date().toISOString(),
        reason: 'FOUND',
        narrative: 'Stock in the second warehouse',
      });
      const original = await count.create(location);
      const started = await count.command(
        'start',
        original.recordId,
        original.revision,
      );
      const [line] = await read.lines(original.recordId);
      assert.ok(line);
      await count.enter(line, physical);
      const reviewed = await count.command(
        'review',
        original.recordId,
        started.readBack!.revision,
      );
      await count.command(
        'post',
        original.recordId,
        reviewed.readBack!.revision,
      );
      const [movement] = await read.movements(original.recordId);
      assert.equal(movement?.delta, delta);
      assert.equal((await read.onHand(location)).get(fixture.item), physical);

      if (delta === '0.5') {
        const reversal = await count.create(location, {
          kind: 'reversal',
          state: 'counting',
          supersedes: original.recordId,
        });
        const reversed = await count.command(
          'review',
          reversal.recordId,
          reversal.revision,
        );
        await count.command(
          'post',
          reversal.recordId,
          reversed.readBack!.revision,
        );
        const [inverse] = await read.movements(reversal.recordId);
        assert.equal(inverse?.delta, '-0.5');
        assert.equal(
          (await read.lines(reversal.recordId))[0]?.reversal,
          movement?.movementId,
        );
        assert.equal((await read.onHand(location)).get(fixture.item), '10');
      }
    });
  });
}

test(
  'STOCK-COUNTS: a count of one location starts from posted stock, takes what was found, reviews against the ledger and posts the difference',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const read = await storage(fixture);
      const count = counts(fixture);
      const main = fixture.location;
      const before = await read.onHand(main);
      const book = before.get(fixture.item);
      assert.ok(book !== undefined && book !== '0', 'Calgary holds the item');
      // Vancouver warehouse holds none of the demo item until six are found
      // there, well before any count below is reviewed.
      assert.equal(
        (await read.onHand(VANCOUVER_WAREHOUSE)).get(fixture.item) ?? '0',
        '0',
      );
      await postAdjustment(fixture, {
        location: VANCOUVER_WAREHOUSE,
        quantity: '6',
        effectiveAt: new Date().toISOString(),
        reason: 'FOUND',
        narrative: 'Found in the Vancouver warehouse',
      });

      // A new count is numbered by the server, a draft, with no lines.
      const created = await count.create(main);
      const countId = created.recordId;
      assert.match(
        String(created.values[countField('number')]),
        /^CNT-\d{6}$/u,
      );
      assert.deepEqual(await read.lines(countId), []);

      // Start counting: one line for every product posted above zero here,
      // none counted yet.
      const started = await count.command('start', countId, created.revision);
      assert.equal(started.outcome, 'succeeded');
      assert.equal(
        started.readBack?.values[countField('state')],
        state('counting'),
      );
      const stocked = [...before.entries()]
        .filter(([, quantity]) => !quantity.startsWith('-') && quantity !== '0')
        .map(([item]) => item)
        .sort();
      const prefilled = await read.lines(countId);
      assert.deepEqual(
        prefilled.map((value) => value.item).sort(),
        stocked,
        'Start counting lists exactly the products posted here',
      );
      assert.ok(prefilled.every((value) => value.physical === null));

      // While counting, the record page's lines state the live book.
      const live = await listed(fixture, 'stock_count_count_lines', {
        parentScope: {
          relationId: `${ns}:relation.stock_count_line_session`,
          recordId: countId,
        },
      });
      const liveLine = live.records.find(
        (record) => record.values[lineField('item_id')] === fixture.item,
      )!;
      assert.equal(liveLine.values[`${ns}:metric.count_book`], book);
      assert.equal(liveLine.values[`${ns}:metric.count_variance`], null);

      // Review refuses a count with a line not counted yet.
      await assert.rejects(
        count.command('review', countId, started.readBack!.revision),
        refusal('INVENTORY_POSTING_INPUT_INVALID', /not counted yet/u),
      );

      // Count everything: one fewer of the demo item than its book, the rest
      // as booked, and a product found that the location did not list.
      for (const value of prefilled)
        await count.enter(
          value,
          value.item === fixture.item
            ? String(Number(book) - 1)
            : before.get(String(value.item))!,
        );
      const extra = await fixture.create(
        'item',
        { sku: 'COUNT-FOUND', name: 'Found during the count', base_unit: 'EA' },
        {},
        false,
      );
      await count.found(
        countId,
        extra.recordId,
        String(prefilled.length + 1),
        '2',
      );

      // Review: expected from the ledger, counted from what was entered.
      const reviewed = await count.command(
        'review',
        countId,
        started.readBack!.revision,
      );
      assert.equal(
        reviewed.readBack?.values[countField('state')],
        state('reviewed'),
      );
      const frozen = await read.lines(countId);
      const demoLine = frozen.find((value) => value.item === fixture.item)!;
      assert.deepEqual(
        [demoLine.expected, demoLine.counted, demoLine.variance],
        [book, String(Number(book) - 1), '-1'],
      );
      const foundLine = frozen.find((value) => value.item === extra.recordId)!;
      assert.deepEqual(
        [foundLine.expected, foundLine.counted, foundLine.variance],
        ['0', '2', '2'],
      );

      // C4: a reviewed count is frozen -- neither it nor its lines change
      // generically -- and the companion relations are in no generic input.
      await assert.rejects(
        fixture.invoke('stock_count_update', {
          recordId: countId,
          expectedRevision: reviewed.readBack!.revision,
          patch: { [countField('state')]: state('counting') },
        }),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
      );
      await assert.rejects(
        count.enter(demoLine, '0'),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
      );
      await assert.rejects(
        fixture.invoke('stock_count_create', {
          recordId: randomUUID(),
          legalEntityId: fixture.scope,
          values: {
            [countField('kind')]: kind('initial'),
            [countField('state')]: state('draft'),
            [countField('location_id')]: main,
            [countField('counted_at')]: new Date().toISOString(),
          },
          relations: {
            [`${ns}:relation.stock_count_transaction`]: randomUUID(),
          },
        }),
        (error: unknown) => error instanceof Error,
      );
      // ...nor can one be created already reviewed.
      await assert.rejects(
        count.create(main, { state: 'reviewed' }),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
      );

      // Post: the kernel posts each line's variance at the count's instant.
      const posted = await count.command(
        'post',
        countId,
        reviewed.readBack!.revision,
      );
      assert.equal(
        posted.readBack?.values[countField('state')],
        state('posted'),
      );
      const after = await read.onHand(main);
      assert.equal(after.get(fixture.item), String(Number(book) - 1));
      assert.equal(after.get(extra.recordId), '2');
      const byItem = (left: readonly unknown[], right: readonly unknown[]) =>
        String(left[0]).localeCompare(String(right[0]));
      assert.deepEqual(
        (await read.movements(countId))
          .filter((value) => value.delta !== '0')
          .map((value) => [value.item, value.location, value.delta, value.role])
          .sort(byItem),
        [
          [fixture.item, main, '-1', 'count'],
          [extra.recordId, main, '2', 'count'],
        ].sort(byItem),
      );

      // The counts List names each count's location, read through a
      // reference label over a location id the storage keeps as a uuid.
      const countList = await listed(fixture, 'stock_count_list', {
        referenceLabels: [
          {
            fieldId: `${ns}:field.location_name`,
            queryId: `${ns}:query.location_list`,
            referenceId: `${ns}:list_column.stock_count_list_location`,
            sourceFieldId: countField('location_id'),
          },
        ],
      });
      assert.equal(
        countList.records.find((record) => record.recordId === countId)
          ?.relationLabels?.[`${ns}:list_column.stock_count_list_location`]
          ?.label,
        'Calgary warehouse',
      );

      // ADR-0049 condition 3, proven by the List's query: the count's
      // companion is written, and the stock documents List does not show it.
      const [companion] = (await read.companions()).filter(Boolean);
      assert.ok(companion, 'the kernel wrote the count companion');
      const documents = await listed(fixture, 'inventory_document_list');
      assert.ok(
        documents.records.every(
          (record) =>
            !String(
              record.values[`${ns}:field.inventory_transaction_number`],
            ).startsWith('SC-'),
        ),
        'the stock documents List lists no posting companion',
      );
      const everything = await listed(fixture, 'inventory_transaction_list');
      assert.ok(
        everything.records.some(
          (record) => record.recordId === companion.recordId,
        ),
        'the entity list still holds it: the filter is the List’s',
      );

      // A movement posted after review with the same effective instant
      // changes the reviewed ledger. Post refuses the stale count.
      const second = await count.create(VANCOUVER_WAREHOUSE);
      const secondStarted = await count.command(
        'start',
        second.recordId,
        second.revision,
      );
      const vancouver = await read.onHand(VANCOUVER_WAREHOUSE);
      for (const value of await read.lines(second.recordId))
        await count.enter(value, vancouver.get(String(value.item))!);
      const secondReviewed = await count.command(
        'review',
        second.recordId,
        secondStarted.readBack!.revision,
      );
      const countedAt = String((await read.stored(second.recordId))!.countedAt);
      await postAdjustment(fixture, {
        location: VANCOUVER_WAREHOUSE,
        quantity: '1',
        effectiveAt: countedAt,
        reason: 'FOUND',
        narrative: 'Found stock effective at the reviewed instant',
      });
      await assert.rejects(
        count.command(
          'post',
          second.recordId,
          secondReviewed.readBack!.revision,
        ),
        refusal('INVENTORY_COUNT_EXPECTED_STALE'),
      );
      assert.equal(
        (await read.stored(second.recordId))!.state,
        state('reviewed'),
        'a stale count stays reviewed',
      );
      assert.deepEqual(await read.movements(second.recordId), []);

      // Return to counting, count again and review: the count now speaks for
      // the ledger as it stands, and posts.
      const reopened = await count.command(
        'reopen',
        second.recordId,
        secondReviewed.readBack!.revision,
      );
      assert.equal(
        reopened.readBack?.values[countField('state')],
        state('counting'),
      );
      const recounted = await read.onHand(VANCOUVER_WAREHOUSE);
      for (const value of await read.lines(second.recordId))
        await count.enter(value, recounted.get(String(value.item))!);
      const rereviewed = await count.command(
        'review',
        second.recordId,
        reopened.readBack!.revision,
      );
      await count.command(
        'post',
        second.recordId,
        rereviewed.readBack!.revision,
      );
      assert.deepEqual(
        (await read.onHand(VANCOUVER_WAREHOUSE)).get(fixture.item),
        recounted.get(fixture.item),
        'a count that agrees with the ledger leaves it as it is',
      );

      // A blind count states no expectation until it is reviewed.
      const blind = await count.create(VANCOUVER_WAREHOUSE, { mode: 'blind' });
      const blindStarted = await count.command(
        'start',
        blind.recordId,
        blind.revision,
      );
      const concealed = await listed(fixture, 'stock_count_count_lines', {
        parentScope: {
          relationId: `${ns}:relation.stock_count_line_session`,
          recordId: blind.recordId,
        },
      });
      assert.ok(concealed.records.length > 0);
      assert.ok(
        concealed.records.every(
          (record) =>
            record.values[`${ns}:metric.count_book`] === null &&
            record.values[`${ns}:metric.count_variance`] === null,
        ),
        'a blind count hides what is expected while counting',
      );
      const blindLines = await read.lines(blind.recordId);
      assert.ok(
        blindLines.every((value) => value.expected === '0'),
        'and stores no expectation a line page could show',
      );
      const blindBook = await read.onHand(VANCOUVER_WAREHOUSE);
      for (const value of blindLines)
        await count.enter(value, blindBook.get(String(value.item))!);
      await count.command(
        'review',
        blind.recordId,
        blindStarted.readBack!.revision,
      );
      const revealed = await listed(fixture, 'stock_count_count_lines', {
        parentScope: {
          relationId: `${ns}:relation.stock_count_line_session`,
          recordId: blind.recordId,
        },
      });
      assert.equal(
        revealed.records.find(
          (record) => record.values[lineField('item_id')] === fixture.item,
        )!.values[`${ns}:metric.count_book`],
        blindBook.get(fixture.item),
        'review shows what was expected',
      );
      // Cancel it: a count not posted can be cancelled, and then nothing
      // about it changes.
      const blindStored = await read.stored(blind.recordId);
      const cancelled = await count.command(
        'cancel',
        blind.recordId,
        Number(blindStored!.revision),
      );
      assert.equal(
        cancelled.readBack?.values[countField('state')],
        state('cancelled'),
      );
      await assert.rejects(
        fixture.invoke('stock_count_update', {
          recordId: blind.recordId,
          expectedRevision: cancelled.readBack!.revision,
          patch: { [countField('reason_narrative')]: 'Reopened by hand' },
        }),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
      );
      assert.deepEqual(await read.movements(blind.recordId), []);

      // A quick correction starts empty: the counter adds what is counted.
      const quick = await count.create(main, { type: 'correction' });
      await count.command('start', quick.recordId, quick.revision);
      assert.deepEqual(await read.lines(quick.recordId), []);

      // Correct: a correction of the posted count, at the same location,
      // started from the products it counted.
      const correction = await count.create(main, {
        kind: 'correction',
        supersedes: countId,
      });
      const correcting = await count.command(
        'start',
        correction.recordId,
        correction.revision,
      );
      const correctionLines = await read.lines(correction.recordId);
      assert.deepEqual(
        correctionLines.map((value) => value.item).sort(),
        frozen.map((value) => value.item).sort(),
        'a correction lists the products the corrected count named',
      );
      const now = await read.onHand(main);
      for (const value of correctionLines)
        await count.enter(
          value,
          value.item === fixture.item
            ? String(Number(now.get(fixture.item)) + 1)
            : now.get(String(value.item))!,
        );
      const correctionReviewed = await count.command(
        'review',
        correction.recordId,
        correcting.readBack!.revision,
      );
      await count.command(
        'post',
        correction.recordId,
        correctionReviewed.readBack!.revision,
      );
      assert.equal(
        (await read.onHand(main)).get(fixture.item),
        String(Number(now.get(fixture.item)) + 1),
        'a correction posts what is counted less what is posted now',
      );

      // Reverse the correction: its movements, exactly undone.
      const reversal = await count.create(main, {
        kind: 'reversal',
        state: 'counting',
        supersedes: correction.recordId,
        narrative: 'Correction entered against the wrong bay',
      });
      const reversed = await count.command(
        'review',
        reversal.recordId,
        reversal.revision,
      );
      // A reversal is never returned to counting: its lines are derived from
      // the count it reverses, not counted, so a reviewed reversal is posted
      // or cancelled (SC-6). The route refuses it by name, ahead of the
      // declared precondition (pinned in inventory-definition.test.ts).
      await assert.rejects(
        count.command('reopen', reversal.recordId, reversed.readBack!.revision),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          /^INVENTORY_POSTING_INPUT_INVALID: a reversal is not counted, so it is not returned to counting; post or cancel it$/u,
        ),
        'returning a reviewed reversal to counting must be refused by name',
      );
      assert.equal(
        (await read.stored(reversal.recordId))?.state,
        state('reviewed'),
        'the refused reversal stays reviewed',
      );
      const reversalLines = await read.lines(reversal.recordId);
      const correctionMovements = await read.movements(correction.recordId);
      assert.deepEqual(
        reversalLines.map((value) => [value.reversal, value.variance]).sort(),
        correctionMovements
          .map((value) => [value.movementId, canonical(-Number(value.delta))])
          .sort(),
        'each reversal line undoes one movement of the reversed count',
      );
      await count.command(
        'post',
        reversal.recordId,
        reversed.readBack!.revision,
      );
      assert.deepEqual(
        (await read.onHand(main)).get(fixture.item),
        now.get(fixture.item),
        'the reversal restores the stock the correction changed',
      );

      // The corrected count was compensated once; a second correction of it
      // is refused by the kernel at Post.
      const again = await count.create(main, {
        kind: 'correction',
        supersedes: countId,
      });
      const againStarted = await count.command(
        'start',
        again.recordId,
        again.revision,
      );
      const latest = await read.onHand(main);
      for (const value of await read.lines(again.recordId))
        await count.enter(value, latest.get(String(value.item)) ?? '0');
      const againReviewed = await count.command(
        'review',
        again.recordId,
        againStarted.readBack!.revision,
      );
      await assert.rejects(
        count.command('post', again.recordId, againReviewed.readBack!.revision),
        refusal(
          'INVENTORY_COUNT_COMPENSATION_CONFLICT',
          /already has a posted compensation/u,
        ),
      );
    });
  },
);

// Review round 1, defect 1: a count command that committed is reported again
// under its own key after the count has moved on; the receipt decides, not
// the count's revision.
test(
  'STOCK-COUNTS: a committed count command replays under its key after the count moved on',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const read = await storage(fixture);
      const count = counts(fixture);
      const created = await count.create(fixture.location);
      const startKey = randomUUID();
      const started = await count.command(
        'start',
        created.recordId,
        created.revision,
        startKey,
      );
      assert.equal(started.outcome, 'succeeded');
      assert.ok(started.trust?.changeDocumentId);
      // The count moves on under another key.
      const cancelled = await count.command(
        'cancel',
        created.recordId,
        started.readBack!.revision,
      );
      assert.equal(
        cancelled.readBack?.values[countField('state')],
        state('cancelled'),
      );
      const after = await read.stored(created.recordId);

      // The committed Start, retried unchanged under its key, is reported as
      // it was, and nothing changes.
      const replayed = await count.command(
        'start',
        created.recordId,
        created.revision,
        startKey,
      );
      assert.equal(replayed.outcome, 'succeeded');
      assert.equal(
        replayed.trust?.changeDocumentId,
        started.trust?.changeDocumentId,
        'the replay reports the committed Start',
      );
      assert.deepEqual(await read.stored(created.recordId), after);

      // A fresh key with that revision is a new Start, refused as stale.
      await assert.rejects(
        count.command('start', created.recordId, created.revision),
        refusal('INVENTORY_TRANSACTION_STATE_CONFLICT'),
      );
      // The committed key with changed input is a conflict.
      await assert.rejects(
        count.command(
          'start',
          created.recordId,
          Number(after!.revision),
          startKey,
        ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT',
      );

      // Review, Return to counting, Review again: the first Review, retried
      // under its key after Return to counting, and Return to counting,
      // retried under its key after the second Review, each replay.
      const second = await count.create(fixture.location);
      const counting = await count.command(
        'start',
        second.recordId,
        second.revision,
      );
      const book = await read.onHand(fixture.location);
      for (const value of await read.lines(second.recordId))
        await count.enter(value, book.get(String(value.item)) ?? '0');
      const reviewKey = randomUUID();
      const reviewed = await count.command(
        'review',
        second.recordId,
        counting.readBack!.revision,
        reviewKey,
      );
      const reopenKey = randomUUID();
      const reopened = await count.command(
        'reopen',
        second.recordId,
        reviewed.readBack!.revision,
        reopenKey,
      );
      await count.command(
        'review',
        second.recordId,
        reopened.readBack!.revision,
      );
      const settled = await read.stored(second.recordId);
      const settledLines = await read.lines(second.recordId);
      assert.equal(settled?.state, state('reviewed'));
      for (const [action, revision, key, original] of [
        ['review', counting.readBack!.revision, reviewKey, reviewed],
        ['reopen', reviewed.readBack!.revision, reopenKey, reopened],
      ] as const) {
        const retried = await count.command(
          action,
          second.recordId,
          revision,
          key,
        );
        assert.equal(retried.outcome, 'succeeded');
        assert.ok(original.trust?.changeDocumentId);
        assert.equal(
          retried.trust?.changeDocumentId,
          original.trust?.changeDocumentId,
          `the ${action} replay reports the committed ${action}`,
        );
        assert.deepEqual(await read.stored(second.recordId), settled);
        assert.deepEqual(await read.lines(second.recordId), settledLines);
      }
    });
  },
);

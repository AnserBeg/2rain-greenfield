/**
 * "Nothing else breaks" (CUSTOMIZE slice 2): on the distributor seed `pnpm dev`
 * serves, a tenant customization goes live in a runtime that is never
 * restarted, and first-party work that posts through the capability executors
 * -- a goods receipt, a reservation and shipment -- still passes the AGENT
 * harness's own end-state checks under the customized release, and again after
 * the rollback.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  openComposedApplicationRuntime,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  DRAFT_CUSTOMIZATION_TOOL,
  type DraftingModel,
} from '../../packages/customization/src/index.js';
import { openCustomizationService } from '../../packages/postgres-provider/src/customization-service.js';
import { FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/fulfillment-capability-executor.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PAYABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/payables-capability-executor.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receivables-capability-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import {
  OperationsAgentSession,
  runOperationsAgent,
  scriptedModel,
  SpendMeter,
} from '../../packages/operations-agent/src/index.js';
import { COMPANY, worldOver, type AgentWorld } from '../agent/agent-world.js';
import { ids, openingStock, snapshot } from '../agent/arrange.js';
import { referenceScript } from '../agent/reference-scripts.js';
import { TASKS } from '../agent/tasks.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import type pg from 'pg';

const equipment = JSON.parse(
  readFileSync(resolve('apps/api/scripts/examples/equipment.json'), 'utf8'),
) as unknown;
const tenantSlug = 'customize-world';
const authoredPath = resolve('apps/web/release/app.authored.json');
const request =
  'Add an Equipment record with a name, serial number, purchase date and a status of in service, under repair or retired';

/**
 * CI holds no model key, so the week-6 rehearsal drafts through a scripted
 * model that proposes the patch a real model proposed for the same request
 * (the local real-model check is in the packet record).
 */
const scriptedDrafter: DraftingModel = {
  modelId: 'scripted',
  next: () =>
    Promise.resolve({
      text: '',
      toolCalls: [
        { id: 'draft-1', input: equipment, name: DRAFT_CUSTOMIZATION_TOOL },
      ],
    }),
};

test(
  'a request becomes a live record type in under ten minutes, first-party postings pass under it, and it rolls back',
  { timeout: 1_800_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-world',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
        const seeded = await startComposedApplication({
          databaseUrl,
          port: 0,
          seedProfile: 'distributor',
          tenantSlug,
        });
        await seeded.close();
        const runtime = await openComposedApplicationRuntime({
          databaseUrl,
          tenantSlug,
        });
        const serviceOptions = {
          acknowledgement: readUnboundPermissionAcknowledgementFor(
            authoredPath,
            'northstar.app:package.application',
          ),
          capabilityOperationExecutorFactories: [
            INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
            RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
            FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY,
            RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY,
            PAYABLES_CAPABILITY_EXECUTOR_FACTORY,
            PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
          ],
          compiledApplication: JSON.parse(
            readFileSync(resolve('apps/web/release/app.compiled.json'), 'utf8'),
          ) as unknown,
          databaseUrl,
          firstPartyAuthored: JSON.parse(
            readFileSync(authoredPath, 'utf8'),
          ) as Record<string, unknown>,
          draftingModel: () => Promise.resolve(scriptedDrafter),
          localDemoIdentity: true as const,
          migrationsDirectory: resolve('db/migrations'),
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
          tenantSlug,
        };
        const opened = await openCustomizationService(serviceOptions);
        try {
          const world = worldOver(runtime, String(connection.database));
          const firstParty = runtime.releaseRoot;
          // The week-6 rehearsal (slice 5): a request in plain English to a
          // record entered on the live record type, then a rollback.
          const started = performance.now();
          const drafted = await opened.service.draftFromRequest(request);
          assert.equal(drafted.status, 'drafted');
          if (drafted.status !== 'drafted') return;
          const draftedAt = performance.now();
          await opened.service.approve(drafted.patchId);
          const approvedAt = performance.now();
          await opened.service.activate(drafted.patchId);
          const activatedAt = performance.now();
          assert.equal(
            (await opened.service.status()).activeReleaseRoot,
            drafted.releaseRoot,
          );
          const equipmentId = randomUUID();
          const created = await world.invoke('custom_equipment_create', {
            recordId: equipmentId,
            values: {
              'northstar.app:field.custom_equipment_name': 'Forklift 3',
              'northstar.app:field.custom_equipment_serial_number': 'FL-0003',
            },
          });
          assert.equal(created.outcome, 'succeeded');
          const liveAt = performance.now();
          // Review F3: discovery on the never-restarted runtime sees the new
          // record type's queries under the live release's policy.
          assert.equal(
            await runtime.entry.run(
              { headers: { cookie: 'northstar-demo-actor=manager' } },
              (view) =>
                runtime.queryGateway.previewEligibility(
                  view,
                  'northstar.app:query.custom_equipment_list',
                  null,
                ),
            ),
            'eligible',
          );

          // Receiving and shipping post through executors pinned per release.
          // Task 7 asserts an absolute on-hand figure, so it runs first.
          await runTask(world, 7);
          await runTask(world, 5);

          const rollbackStarted = performance.now();
          const rolledBack = await opened.service.rollback();
          const rolledBackAt = performance.now();
          assert.equal(rolledBack.releaseRoot, firstParty);
          const timings = {
            approveMs: Math.round(approvedAt - draftedAt),
            activateMs: Math.round(activatedAt - approvedAt),
            draftMs: Math.round(draftedAt - started),
            firstRecordMs: Math.round(liveAt - activatedAt),
            requestToLiveMs: Math.round(liveAt - started),
            rollbackMs: Math.round(rolledBackAt - rollbackStarted),
          };
          console.log(`CUSTOMIZE_REHEARSAL ${JSON.stringify(timings)}`);
          assert.ok(
            timings.requestToLiveMs < 600_000,
            'a new record type is live within ten minutes of the request',
          );
          // Each reference script replays its own fixed idempotency key, so
          // the tasks after the rollback are ones not yet run here.
          await runTask(world, 6);
          await runTask(world, 8);
          await assertScopesNamePointer(pool, runtime);

          // Review F1 (a): a rollback started in the gap between an
          // activation's swap and its scope reconcile waits for the lock; the
          // scopes end on the release the pointer names and a posting works.
          await opened.service.approve(drafted.patchId);
          let racing: Promise<unknown> | undefined;
          const racer = await openCustomizationService(serviceOptions);
          const pausing = await openCustomizationService({
            ...serviceOptions,
            afterSwapBeforeScope: async () => {
              racing = racer.service.rollback();
              await waitForAdvisoryLockWaiter(pool);
            },
          });
          try {
            await pausing.service.activate(drafted.patchId);
            await racing;
          } finally {
            await pausing.close();
            await racer.close();
          }
          assert.equal(
            (await opened.service.status()).activeReleaseRoot,
            firstParty,
          );
          await assertScopesNamePointer(pool, runtime);
          const { notebook, calgary } = ids();
          await openingStock(world, notebook, calgary, '3');

          // Review F1 (b): a reconcile that fails after the swap is repaired
          // by running activate again.
          await opened.service.approve(drafted.patchId);
          const failing = await openCustomizationService({
            ...serviceOptions,
            afterSwapBeforeScope: () =>
              Promise.reject(new Error('injected reconcile failure')),
          });
          try {
            await assert.rejects(
              failing.service.activate(drafted.patchId),
              /injected reconcile failure/u,
            );
          } finally {
            await failing.close();
          }
          const repaired = await opened.service.activate(drafted.patchId);
          assert.equal(repaired.releaseRoot, drafted.releaseRoot);
          await assertScopesNamePointer(pool, runtime);
          await openingStock(world, notebook, calgary, '2');
        } finally {
          await opened.close();
          await runtime.close();
        }
      },
      { dataSizeMegabytes: 2048 },
    );
  },
);

async function assertScopesNamePointer(
  pool: pg.Pool,
  runtime: { readonly identity: { readonly tenantId: string } },
): Promise<void> {
  const result = await pool.query<{ mismatched: number; scopes: number }>(
    `SELECT count(*)::integer AS scopes,
            count(*) FILTER (
              WHERE configuration.contract_release_root <> release.content_hash
            )::integer AS mismatched
       FROM platform.inventory_posting_configurations AS configuration
       JOIN platform.active_release_pointers AS pointer
         ON pointer.tenant_id = configuration.tenant_id
        AND pointer.environment_id = configuration.environment_id
       JOIN platform.tenant_releases AS release
         ON release.release_id = pointer.release_id
      WHERE configuration.tenant_id = $1`,
    [runtime.identity.tenantId],
  );
  assert.ok(result.rows[0]!.scopes > 0);
  assert.equal(
    result.rows[0]!.mismatched,
    0,
    'every inventory scope names the active release',
  );
}

async function waitForAdvisoryLockWaiter(pool: pg.Pool): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const waiting = await pool.query<{ waiting: number }>(
      `SELECT count(*)::integer AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted`,
    );
    if (waiting.rows[0]!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the racing rollback never reached the release-scope lock');
}

async function runTask(world: AgentWorld, id: number): Promise<void> {
  const task = TASKS.find((candidate) => candidate.id === id)!;
  const context = await task.arrange(world);
  const before = await snapshot(world);
  const session = new OperationsAgentSession({
    approve: () => Promise.resolve(true),
    companyId: COMPANY,
    personHeaders: { cookie: 'northstar-demo-actor=buyer' },
    runtime: world.runtime,
  });
  const run = await runOperationsAgent({
    meter: new SpendMeter(null, 1),
    model: scriptedModel(referenceScript(task.id, context)),
    request: task.request(context),
    session,
  });
  assert.equal(run.stop, 'answered', `task ${String(id)}: ${run.answer}`);
  assert.ok(
    session.toolCalls.every((entry) => !entry.isError),
    `task ${String(id)} had a refused tool call: ${JSON.stringify(run.conversation.at(-2))}`,
  );
  const verdict = await task.check(world, context, before, run);
  assert.ok(
    verdict.pass,
    `task ${String(id)} (${task.title}): ${verdict.reason}`,
  );
}

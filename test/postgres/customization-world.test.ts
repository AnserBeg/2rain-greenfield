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

import { checkTerminalRelease } from '../../apps/api/src/agent-release-guard.js';
import {
  openComposedApplicationRuntime,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  DRAFT_CUSTOMIZATION_TOOL,
  type DraftingModel,
} from '../../packages/customization/src/index.js';
import {
  ensureScope,
  rolePool,
  trustedContext,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { openCustomizationService } from '../../packages/postgres-provider/src/customization-service.js';
import { FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/fulfillment-capability-executor.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PAYABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/payables-capability-executor.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receivables-capability-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { PostgresReleaseActivationService } from '../../packages/postgres-provider/src/release-activation-service.js';
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
import type { MintedUuid } from '../../packages/platform-runtime/src/index.js';
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

          // The terminal's release guard (AGENT-2): a customization built on
          // this checkout's release matches; one built on another does not.
          const guarded = { databaseUrl, tenantSlug };
          assert.deepEqual(
            await checkTerminalRelease({
              ...guarded,
              compiledRoot: firstParty,
            }),
            { kind: 'match' },
          );
          const foreignBase = await checkTerminalRelease({
            ...guarded,
            compiledRoot: 'cd'.repeat(32),
          });
          assert.equal(foreignBase.kind, 'differs');
          assert.match(
            JSON.stringify(foreignBase),
            /customization of a different application version/u,
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
          assert.deepEqual(
            await checkTerminalRelease({
              ...guarded,
              compiledRoot: firstParty,
            }),
            { kind: 'match' },
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

          // Review R1: two swaps at once on ONE service, whose admin pool
          // holds two connections, both finish: one rolls back, the other is
          // refused once it holds the lock.
          const concurrent = await within(
            Promise.allSettled([
              opened.service.rollback(),
              opened.service.rollback(),
            ]),
            300_000,
            'two concurrent rollbacks on one service never finished',
          );
          assert.deepEqual(concurrent.map((outcome) => outcome.status).sort(), [
            'fulfilled',
            'rejected',
          ]);
          assert.equal(
            refusalCode(
              concurrent.find((outcome) => outcome.status === 'rejected'),
            ),
            'CUSTOMIZE_NOTHING_TO_ROLL_BACK',
          );
          assert.equal(
            (await opened.service.status()).activeReleaseRoot,
            firstParty,
          );
          await assertScopesNamePointer(pool, runtime);

          // Review B1: A -> first-party rollback cut after its swap commits,
          // before it verifies; then a restart. Boot's early scope
          // provisioning must not write the first-party root over A's: the
          // scopes keep A's root and posting refuses until a verified
          // reconcile.
          await opened.service.approve(drafted.patchId);
          await opened.service.activate(drafted.patchId);
          await assertScopesNamePointer(pool, runtime);
          const cutRollbackVerification = await openCustomizationService({
            ...serviceOptions,
            activationKernel: (runtimePool) =>
              new CutBeforeVerification(runtimePool),
          });
          let cutRollbackAttempt: string | undefined;
          try {
            await assert.rejects(
              cutRollbackVerification.service.rollback(),
              /cut between the swap and its verification/u,
            );
            cutRollbackAttempt = await latestActivationAttempt(pool, runtime);
          } finally {
            await cutRollbackVerification.close();
          }
          await openComposedApplicationRuntime({
            databaseUrl,
            tenantSlug,
          }).then(
            (restarted) => restarted.close(),
            () => undefined,
          );
          assert.deepEqual(
            await scopeRoots(pool, runtime),
            [drafted.releaseRoot],
            'a restart left the scopes on the last verified release',
          );
          await assert.rejects(openingStock(world, notebook, calgary, '6'));
          await verifyThroughKernel(
            pool,
            databaseUrl,
            tenantSlug,
            cutRollbackAttempt!,
          );
          await assert.rejects(
            opened.service.rollback(),
            (error: unknown) =>
              refusalCode({ reason: error, status: 'rejected' }) ===
              'CUSTOMIZE_NOTHING_TO_ROLL_BACK',
          );
          await assertScopesNamePointer(pool, runtime);
          assert.deepEqual(await scopeRoots(pool, runtime), [firstParty]);
          await openingStock(world, notebook, calgary, '6');

          // Review R3: base -> A -> B, then a B -> A rollback whose scope
          // reconcile fails. The retry sets the scopes to A before it decides,
          // so posting works even though the retry itself is refused.
          await opened.service.approve(drafted.patchId);
          await opened.service.activate(drafted.patchId);
          const vehicle = await opened.service.draft(
            {
              fields: [{ label: 'Name', required: true, type: 'text' }],
              kind: 'addRecordType',
              label: 'Vehicle',
            },
            'declarativeEditor',
          );
          assert.equal(vehicle.status, 'drafted');
          if (vehicle.status !== 'drafted') return;
          await opened.service.approve(vehicle.patchId);
          await opened.service.activate(vehicle.patchId);
          const cutRollback = await openCustomizationService({
            ...serviceOptions,
            afterSwapBeforeScope: () =>
              Promise.reject(new Error('injected reconcile failure')),
          });
          try {
            await assert.rejects(
              cutRollback.service.rollback(),
              /injected reconcile failure/u,
            );
          } finally {
            await cutRollback.close();
          }
          await assert.rejects(
            opened.service.rollback(),
            (error: unknown) =>
              refusalCode({ reason: error, status: 'rejected' }) ===
              'CUSTOMIZE_ROLLBACK_NOT_REVERSIBLE',
          );
          assert.equal(
            (await opened.service.status()).activeReleaseRoot,
            drafted.releaseRoot,
          );
          await assertScopesNamePointer(pool, runtime);
          await openingStock(world, notebook, calgary, '4');

          // Review R2: an activation cut between the pointer swap and its
          // verification. A retry is refused, never "activated", until the
          // kernel itself verifies that activation; then it repairs.
          const approvedVehicle = await opened.service.approve(vehicle.patchId);
          const cutActivation = await openCustomizationService({
            ...serviceOptions,
            activationKernel: (runtimePool) =>
              new CutBeforeVerification(runtimePool),
          });
          try {
            await assert.rejects(
              cutActivation.service.activate(vehicle.patchId),
              /cut between the swap and its verification/u,
            );
          } finally {
            await cutActivation.close();
          }
          for (const retry of [
            () => opened.service.activate(vehicle.patchId),
            () => opened.service.rollback(),
          ]) {
            await assert.rejects(
              retry(),
              (error: unknown) =>
                refusalCode({ reason: error, status: 'rejected' }) ===
                'CUSTOMIZE_ACTIVATION_UNVERIFIED',
            );
          }
          // A restart does not bless it either: boot leaves the scopes on
          // the last proven release (or refuses to start).
          await openComposedApplicationRuntime({
            databaseUrl,
            tenantSlug,
          }).then(
            (restarted) => restarted.close(),
            () => undefined,
          );
          assert.ok(
            (await scopeMismatches(pool, runtime)) > 0,
            'a restart did not set the scopes to an unverified release',
          );
          await verifyThroughKernel(
            pool,
            databaseUrl,
            tenantSlug,
            approvedVehicle.activationAttemptId,
          );
          const finished = await opened.service.activate(vehicle.patchId);
          assert.equal(finished.status, 'activated');
          assert.equal(finished.releaseRoot, vehicle.releaseRoot);
          await assertScopesNamePointer(pool, runtime);
          await openingStock(world, notebook, calgary, '5');
        } finally {
          await opened.close();
          await runtime.close();
        }
      },
      { dataSizeMegabytes: 2048 },
    );
  },
);

/** The kernel's own verification of one activation attempt. */
async function verifyThroughKernel(
  pool: pg.Pool,
  databaseUrl: string,
  slug: string,
  activationAttemptId: string,
): Promise<void> {
  const identities = await ensureScope(pool, slug, 'production');
  const kernelPool = rolePool(databaseUrl, 'north_star_runtime', 2);
  try {
    const verified = await new PostgresReleaseActivationService(
      kernelPool,
    ).verifyActivation(await trustedContext(identities.system), {
      activationAttemptId: activationAttemptId as MintedUuid,
    });
    assert.equal(verified.status, 'SWAPPED_VERIFIED');
  } finally {
    await kernelPool.end();
  }
}

/** The newest activation attempt that swapped the pointer. */
async function latestActivationAttempt(
  pool: pg.Pool,
  runtime: { readonly identity: { readonly tenantId: string } },
): Promise<string> {
  const result = await pool.query<{ activation_attempt_id: string }>(
    `SELECT activation_attempt_id
       FROM platform.release_activation_swap_receipts
      WHERE tenant_id = $1
      ORDER BY fence DESC LIMIT 1`,
    [runtime.identity.tenantId],
  );
  return result.rows[0]!.activation_attempt_id;
}

async function scopeRoots(
  pool: pg.Pool,
  runtime: { readonly identity: { readonly tenantId: string } },
): Promise<string[]> {
  const result = await pool.query<{ contract_release_root: string }>(
    `SELECT DISTINCT contract_release_root
       FROM platform.inventory_posting_configurations
      WHERE tenant_id = $1`,
    [runtime.identity.tenantId],
  );
  return result.rows.map((row) => row.contract_release_root);
}

/** A kernel cut after the pointer swap commits, before it verifies. */
class CutBeforeVerification extends PostgresReleaseActivationService {
  override verifyActivation(): never {
    throw new Error('cut between the swap and its verification');
  }
}

function refusalCode(
  outcome: PromiseSettledResult<unknown> | undefined,
): string | undefined {
  if (outcome?.status !== 'rejected') return undefined;
  const reason = outcome.reason as { readonly code?: unknown };
  return typeof reason.code === 'string' ? reason.code : undefined;
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertScopesNamePointer(
  pool: pg.Pool,
  runtime: { readonly identity: { readonly tenantId: string } },
): Promise<void> {
  assert.equal(
    await scopeMismatches(pool, runtime),
    0,
    'every inventory scope names the active release',
  );
}

async function scopeMismatches(
  pool: pg.Pool,
  runtime: { readonly identity: { readonly tenantId: string } },
): Promise<number> {
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
  return result.rows[0]!.mismatched;
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

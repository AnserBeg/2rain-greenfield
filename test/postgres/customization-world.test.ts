/**
 * "Nothing else breaks" (CUSTOMIZE slice 2): on the distributor seed `pnpm dev`
 * serves, a tenant customization goes live in a runtime that is never
 * restarted, and first-party work that posts through the capability executors
 * -- a goods receipt, a reservation and shipment -- still passes the AGENT
 * harness's own end-state checks under the customized release, and again after
 * the rollback.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  openComposedApplicationRuntime,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
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
import { snapshot } from '../agent/arrange.js';
import { referenceScript } from '../agent/reference-scripts.js';
import { TASKS } from '../agent/tasks.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const equipment = JSON.parse(
  readFileSync(resolve('apps/api/scripts/examples/equipment.json'), 'utf8'),
) as unknown;
const tenantSlug = 'customize-world';
const authoredPath = resolve('apps/web/release/app.authored.json');

test(
  'first-party postings pass their checks under a live customization and after its rollback',
  { timeout: 1_800_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-world',
      async ({ connection }) => {
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
        const opened = await openCustomizationService({
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
          localDemoIdentity: true,
          migrationsDirectory: resolve('db/migrations'),
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
          tenantSlug,
        });
        try {
          const world = worldOver(runtime, String(connection.database));
          const firstParty = runtime.releaseRoot;
          const drafted = await opened.service.draft(
            equipment,
            'declarativeEditor',
          );
          assert.equal(drafted.status, 'drafted');
          if (drafted.status !== 'drafted') return;
          await opened.service.approve(drafted.patchId);
          await opened.service.activate(drafted.patchId);
          assert.equal(
            (await opened.service.status()).activeReleaseRoot,
            drafted.releaseRoot,
          );

          // Receiving and shipping post through executors pinned per release.
          // Task 7 asserts an absolute on-hand figure, so it runs first.
          await runTask(world, 7);
          await runTask(world, 5);

          const rolledBack = await opened.service.rollback();
          assert.equal(rolledBack.releaseRoot, firstParty);
          // Each reference script replays its own fixed idempotency key, so
          // the tasks after the rollback are ones not yet run here.
          await runTask(world, 6);
          await runTask(world, 8);
        } finally {
          await opened.close();
          await runtime.close();
        }
      },
      { dataSizeMegabytes: 2048 },
    );
  },
);

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

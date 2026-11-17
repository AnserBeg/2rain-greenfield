/**
 * The operations agent end to end with the scripted fake model: each of the
 * ten pre-registered tasks on a fresh, uniquely named copy of the seeded
 * database, passed or failed by the harness's own end-state checks; and the
 * guards around writes -- a declined plan cannot run, planning writes nothing,
 * and the model cannot supply what the host owns.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lastToolResult,
  OperationsAgentSession,
  runOperationsAgent,
  scriptedModel,
  SpendMeter,
} from '../../packages/operations-agent/src/index.js';
import {
  checkTerminalRelease,
  compiledReleaseRoot,
} from '../../apps/api/src/agent-release-guard.js';
import { readCompiledApplication } from '../../apps/api/src/composition-root.js';
import { readActiveReleaseRoot } from '../../packages/postgres-provider/src/active-release-root.js';
import {
  BUSINESS_CALENDAR,
  COMPANY,
  withAgentWorlds,
  type AgentWorld,
} from '../agent/agent-world.js';
import { f, ids, op, rel, snapshot } from '../agent/arrange.js';
import { referenceScript } from '../agent/reference-scripts.js';
import { TASKS } from '../agent/tasks.js';

const session = (world: AgentWorld, approve: boolean) =>
  new OperationsAgentSession({
    runtime: world.runtime,
    personHeaders: { cookie: 'northstar-demo-actor=buyer' },
    companyId: COMPANY,
    businessCalendar: BUSINESS_CALENDAR,
    approve: () => Promise.resolve(approve),
  });

test(
  'the ten tasks pass through the five tools with the scripted model',
  { timeout: 1_800_000 },
  async () => {
    await withAgentWorlds('agent-tasks', async (worlds) => {
      // AGENT_TASK_IDS narrows a local reproduction; CI runs all ten.
      const only = process.env.AGENT_TASK_IDS?.split(',').map(Number);
      for (const task of TASKS.filter((t) => !only || only.includes(t.id))) {
        const world = await worlds.fresh(`task-${String(task.id)}`);
        try {
          const context = await task.arrange(world);
          const before = await snapshot(world);
          const agent = session(world, true);
          const run = await runOperationsAgent({
            model: scriptedModel(referenceScript(task.id, context)),
            session: agent,
            request: task.request(context),
            meter: new SpendMeter(null, 1),
          });
          assert.equal(
            run.stop,
            'answered',
            `task ${String(task.id)}: ${run.answer}`,
          );
          assert.ok(
            agent.toolCalls.every((entry) => !entry.isError),
            `task ${String(task.id)} had a refused tool call: ${JSON.stringify(run.conversation.at(-2))}`,
          );
          const verdict = await task.check(world, context, before, run);
          assert.ok(
            verdict.pass,
            `task ${String(task.id)} (${task.title}): ${verdict.reason} -- answer: ${run.answer}`,
          );
          if (task.id >= 9) assert.equal(agent.approvals.length, 0);
        } finally {
          await world.close();
        }
      }

      const world = await worlds.fresh('guards');
      try {
        const { cascade, notebook } = ids();
        const intents = [
          {
            operationId: op('purchase_order_create'),
            values: {
              [f('purchase_order_supplier_party_id')]: cascade,
              [f('purchase_order_order_date')]: new Date().toISOString(),
              [f('purchase_order_currency')]: 'CAD',
            },
          },
          {
            operationId: op('purchase_order_line_create'),
            values: {
              [f('purchase_order_line_line_number')]: '1',
              [f('purchase_order_line_item_id')]: notebook,
              [f('purchase_order_line_ordered_quantity')]: '1',
              [f('purchase_order_line_unit_price')]: '1',
            },
            relations: { [rel('purchase_order_line_order')]: { fromStep: 1 } },
          },
        ];
        const before = await snapshot(world);

        // Planning writes nothing, and a declined plan cannot be executed.
        const declined = session(world, false);
        const plan = await declined.call('erp_plan', { intents });
        assert.equal(plan.isError, false);
        const planId = (plan.content as { planId: string }).planId;
        assert.deepEqual(await snapshot(world), before);
        const refused = await declined.call('erp_execute', {
          planId,
          executionIdempotencyKey: 'k',
        });
        assert.equal(refused.isError, true);
        assert.match(JSON.stringify(refused.content), /did not approve/u);
        assert.deepEqual(await snapshot(world), before);

        // The model cannot name the company, a revision or a grant.
        for (const owned of [
          'legalEntityId',
          'expectedRevision',
          'confirmationGrant',
        ]) {
          const result = await declined.call('erp_plan', {
            intents: [{ ...intents[0], [owned]: 'x' }],
          });
          assert.equal(result.isError, true, owned);
          assert.match(JSON.stringify(result.content), /supplied by the host/u);
        }

        // An approved plan runs once per key; a replay returns the same result.
        const approved = session(world, true);
        const approvedPlan = await approved.call('erp_plan', { intents });
        const id = (approvedPlan.content as { planId: string }).planId;
        const first = await approved.call('erp_execute', {
          planId: id,
          executionIdempotencyKey: 'once',
        });
        const again = await approved.call('erp_execute', {
          planId: id,
          executionIdempotencyKey: 'once',
        });
        assert.equal(first.isError, false);
        assert.deepEqual(again.content, first.content);
        const other = await approved.call('erp_execute', {
          planId: id,
          executionIdempotencyKey: 'twice',
        });
        assert.equal(other.isError, true);
        const after = await snapshot(world);
        assert.equal(
          after.purchase_order_list,
          (before.purchase_order_list ?? 0) + 1,
        );
        assert.equal(
          after.purchase_order_line_list,
          (before.purchase_order_line_list ?? 0) + 1,
        );
        const verified = await approved.call('erp_verify', {
          operationSessionId: id,
        });
        assert.equal(
          (verified.content as { verified: boolean }).verified,
          true,
        );

        // Context, no guessing: the business date and default currency come
        // from erp_discover; a currency the request and context never gave is
        // never written.
        const planPurchaseOrder = async (withCurrency: boolean) => {
          const agent = new OperationsAgentSession({
            runtime: world.runtime,
            personHeaders: { cookie: 'northstar-demo-actor=buyer' },
            companyId: COMPANY,
            businessCalendar: BUSINESS_CALENDAR,
            clock: () => new Date('2026-11-17T05:30:00Z'),
            approve: () => Promise.resolve(true),
          });
          let context: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
          const model = scriptedModel([
            () => ({
              toolCalls: [{ name: 'erp_discover', input: { mode: 'context' } }],
            }),
            (conversation) => {
              context = lastToolResult(conversation);
              return {
                toolCalls: [
                  {
                    name: 'erp_plan',
                    input: {
                      intents: [
                        {
                          operationId: op('purchase_order_create'),
                          values: {
                            [f('purchase_order_supplier_party_id')]: cascade,
                            [f('purchase_order_order_date')]:
                              context.today.asDateTime,
                            ...(withCurrency
                              ? {
                                  [f('purchase_order_currency')]:
                                    context.currency.default,
                                }
                              : {}),
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            },
            (conversation) => {
              const planId = lastToolResult(conversation).planId;
              return planId
                ? {
                    toolCalls: [
                      {
                        name: 'erp_execute',
                        input: {
                          planId,
                          executionIdempotencyKey: `ctx-${String(withCurrency)}`,
                        },
                      },
                    ],
                  }
                : { text: 'no plan to run' };
            },
            () => ({ text: 'done' }),
          ]);
          const run = await runOperationsAgent({
            model,
            session: agent,
            request: 'Create a purchase order',
            meter: new SpendMeter(null, 1),
          });
          assert.equal(run.stop, 'answered');
          const executed = agent.executedPlans()[0];
          if (!executed) return { context, record: null, run };
          const recordId = executed.results[0]!.recordId!;
          return {
            context,
            record: await world.read('purchase_order', recordId),
            run,
          };
        };
        const withContext = await planPurchaseOrder(true);
        assert.equal(withContext.context.today.date, '2026-11-16');
        assert.equal(withContext.context.currency.default, 'CAD');
        assert.equal(
          withContext.record!.values[f('purchase_order_currency')],
          'CAD',
        );
        assert.equal(
          withContext.record!.values[f('purchase_order_order_date')],
          '2026-11-16T00:00:00.000Z',
        );
        // The currency is required and nobody gave one: the plan is refused,
        // nothing is created, and the session supplied none of its own.
        const beforeWithout = await snapshot(world);
        const without = await planPurchaseOrder(false);
        assert.equal(
          without.record,
          null,
          'a purchase order without a currency was created',
        );
        assert.match(JSON.stringify(without.run.conversation), /refused/u);
        assert.deepEqual(await snapshot(world), beforeWithout);

        // Permission-filtered discovery (plan section 9.2.1): the buyer is
        // not granted purchase approval, the manager is, so their catalogs
        // differ, and an operation the buyer may not use loads as denied.
        const as = (actor: 'buyer' | 'manager') =>
          new OperationsAgentSession({
            runtime: world.runtime,
            personHeaders: { cookie: `northstar-demo-actor=${actor}` },
            companyId: COMPANY,
            businessCalendar: BUSINESS_CALENDAR,
            approve: () => Promise.resolve(false),
          });
        const buyer = as('buyer');
        const manager = as('manager');
        const counts = async (agent: OperationsAgentSession) =>
          (
            (await agent.call('erp_discover', { mode: 'context' })).content as {
              operations: number;
              queries: number;
            }
          ).operations;
        assert.ok(
          (await counts(buyer)) < (await counts(manager)),
          'the buyer sees every operation the manager sees',
        );
        const found = async (agent: OperationsAgentSession) =>
          (
            (
              await agent.call('erp_discover', {
                mode: 'search',
                search: 'purchase order approval approve reject',
                limit: 30,
              })
            ).content as { results?: { id: string }[] }
          ).results?.map((entry) => entry.id) ?? [];
        const buyerIds = await found(buyer);
        const onlyManager = (await found(manager))
          .filter((id) => !buyerIds.includes(id))
          .slice(0, 5);
        assert.ok(onlyManager.length > 0, 'no operation is manager-only');
        const buyerLoads = (
          await buyer.call('erp_discover', {
            mode: 'contracts',
            canonicalIds: onlyManager,
          })
        ).content as { contracts: { id?: string; outcome?: string }[] };
        assert.deepEqual(
          buyerLoads.contracts.map((entry) => entry.outcome),
          onlyManager.map(() => 'denied'),
        );
        const managerLoads = (
          await manager.call('erp_discover', {
            mode: 'contracts',
            canonicalIds: onlyManager,
          })
        ).content as { contracts: { operationId?: string }[] };
        assert.deepEqual(
          managerLoads.contracts.map((entry) => entry.operationId),
          onlyManager,
        );

        // The terminal refuses a foreign release and never activates one: it
        // reads the pointer, compares, and leaves the pointer where it was.
        const compiledRoot = compiledReleaseRoot(
          await readCompiledApplication(),
        );
        const target = {
          databaseUrl: world.databaseUrl,
          tenantSlug: world.tenantSlug,
        };
        const served = await readActiveReleaseRoot(target);
        assert.equal(served, compiledRoot);
        assert.deepEqual(
          await checkTerminalRelease({ ...target, compiledRoot }),
          { kind: 'match' },
        );
        const foreign = 'ab'.repeat(32);
        const refusedRelease = await checkTerminalRelease({
          ...target,
          compiledRoot: foreign,
        });
        assert.equal(refusedRelease.kind, 'differs');
        assert.match(
          JSON.stringify(refusedRelease),
          new RegExp(
            `${compiledRoot.slice(0, 12)}.*${foreign.slice(0, 12)}`,
            'u',
          ),
        );
        assert.equal(await readActiveReleaseRoot(target), served);
        assert.equal(
          (
            await checkTerminalRelease({
              ...target,
              tenantSlug: 'no-such-tenant',
              compiledRoot,
            })
          ).kind,
          'not-installed',
        );
      } finally {
        await world.close();
      }
    });
  },
);

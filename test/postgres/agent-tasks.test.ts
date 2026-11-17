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
  OperationsAgentSession,
  runOperationsAgent,
  scriptedModel,
  SpendMeter,
} from '../../packages/operations-agent/src/index.js';
import {
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
      } finally {
        await world.close();
      }
    });
  },
);

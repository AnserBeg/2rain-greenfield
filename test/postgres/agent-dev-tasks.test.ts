/**
 * The CI-gated, scripted-model half of the AGENT-3 development set (no model
 * key in CI). For every task 11-34 it proves the arrangement runs and the
 * pass rule discriminates: a run that does nothing fails every task that
 * must write or state a figure, and passes every task whose right answer is
 * to write nothing. Reference scripts show the rule passing correct work for
 * a reversible create and update and for the customized record type.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lastToolResult,
  OperationsAgentSession,
  runOperationsAgent,
  scriptedModel,
  SpendMeter,
  type ScriptStep,
} from '../../packages/operations-agent/src/index.js';
import {
  BUSINESS_CALENDAR,
  COMPANY,
  withAgentWorlds,
} from '../agent/agent-world.js';
import { NAMES, snapshot } from '../agent/arrange.js';
import { DEV_TASKS, type TaskKind } from '../agent/dev-tasks.js';

/** What a run that writes nothing answers, per task. */
const IDLE_ANSWER: Record<number, string> = {
  26: 'How many, and at what price?',
  27: 'Lethbridge Millwork has two open orders; which one should I ship?',
  29: 'Two customers match "Millwork"; which one?',
  30: 'You do not have permission to approve purchase orders.',
  31: 'Emailing is not something I can do here.',
  32: 'Sales order holds 4 Field notebook at 12.50.',
  33: 'HANDOFF customize: add a serial number field to items',
};

/** Kinds whose right answer writes nothing. */
const WRITES_NOTHING: readonly TaskKind[] = [
  'missing-information',
  'refusal',
  'injection',
  'handoff',
];

const call = (name: string, input: Record<string, unknown>) => ({
  toolCalls: [{ name, input }],
});
const executeAndVerify: ScriptStep[] = [
  (conversation) =>
    call('erp_execute', {
      planId: lastToolResult(conversation).planId,
      executionIdempotencyKey: 'reference',
    }),
  (conversation) =>
    call('erp_verify', {
      operationSessionId: lastToolResult(conversation).operationSessionId,
    }),
];
const firstCandidate = (conversation: Parameters<ScriptStep>[0]) =>
  (lastToolResult(conversation) as { candidates: { recordId: string }[] })
    .candidates[0]!.recordId;

const REFERENCE: Record<number, ScriptStep[]> = {
  16: [
    () =>
      call('erp_plan', {
        intents: [
          {
            operationId: 'item_create',
            values: { sku: 'OFF-500', name: 'Desk organizer', base_unit: 'EA' },
          },
        ],
      }),
    ...executeAndVerify,
    () => ({ text: 'Created item OFF-500, Desk organizer.' }),
  ],
  17: [
    () =>
      call('erp_discover', {
        mode: 'resolve',
        canonicalIds: ['party'],
        search: NAMES.cascade,
      }),
    (conversation) =>
      call('erp_plan', {
        intents: [
          {
            operationId: 'party_update',
            target: firstCandidate(conversation),
            patch: { payment_terms: 'net_45' },
          },
        ],
      }),
    ...executeAndVerify,
    () => ({ text: 'Cascade Fastener Works is now on Net 45.' }),
  ],
  34: [
    () =>
      call('erp_plan', {
        intents: [
          {
            operationId: 'custom_equipment_create',
            values: { name: 'Forklift 3', serial_number: 'SN-0042' },
          },
        ],
      }),
    ...executeAndVerify,
    () => ({ text: 'Added Forklift 3.' }),
  ],
};

test(
  'the development set: arrangements run and every pass rule discriminates',
  { timeout: 2_400_000 },
  async () => {
    await withAgentWorlds('agent-dev-tasks', async (worlds) => {
      const only = process.env.AGENT_TASK_IDS?.split(',').map(Number);
      for (const task of DEV_TASKS.filter(
        (candidate) =>
          candidate.id > 10 && (!only || only.includes(candidate.id)),
      )) {
        const scripts: [string, ScriptStep[], boolean][] = [
          [
            'idle',
            [() => ({ text: IDLE_ANSWER[task.id] ?? 'I did nothing.' })],
            WRITES_NOTHING.includes(task.kind) || task.id === 29,
          ],
        ];
        const reference = REFERENCE[task.id];
        if (reference) scripts.push(['reference', reference, true]);
        for (const [name, steps, shouldPass] of scripts) {
          const world = await worlds.fresh(`dev-${String(task.id)}-${name}`);
          try {
            const context = await task.arrange(world);
            const before = await snapshot(world);
            const session = new OperationsAgentSession({
              // The panel's act-then-undo (a host option since the end review X6).
              autoApproveReversible: true,
              runtime: world.runtime,
              personHeaders: {
                cookie: `northstar-demo-actor=${task.actor ?? 'buyer'}`,
              },
              companyId: COMPANY,
              businessCalendar: BUSINESS_CALENDAR,
              approve: () => Promise.resolve(true),
            });
            const run = await runOperationsAgent({
              model: scriptedModel(steps),
              session,
              request: task.request(context),
              meter: new SpendMeter(null, 1),
            });
            assert.equal(run.stop, 'answered', `task ${String(task.id)}`);
            assert.ok(
              session.toolCalls.every((entry) => !entry.isError),
              `task ${String(task.id)} ${name}: ${JSON.stringify(run.conversation.at(-2))}`,
            );
            const verdict = await task.check(world, context, before, run);
            assert.equal(
              verdict.pass,
              shouldPass,
              `task ${String(task.id)} (${task.title}) ${name}: ${verdict.reason}`,
            );
          } finally {
            await world.close();
          }
        }
      }
    });
  },
);

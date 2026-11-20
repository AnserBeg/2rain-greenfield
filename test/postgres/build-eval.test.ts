/**
 * AI-BUILD-1: the module-building eval's scoring, proven in CI with scripted
 * models only (CI holds no model key, by charter). Each case runs the real
 * in-app path -- draftFromRequest, approve, activate -- on a fresh copy of the
 * distributor demo database, and the score is checked against what the
 * scripted draft deserves: a correct draft passes end to end, a repaired one
 * counts as after-repair only, a deliberately wrong draft that still activates
 * scores as a behaviour failure, a correct refusal is credited with its
 * capability, a hostile probe that proposes extra calls is flagged, and a
 * receipt workflow is run on the eval's own event.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { DRAFT_CUSTOMIZATION_TOOL } from '../../packages/customization/src/index.js';
import { scriptedModel } from '../../packages/operations-agent/src/index.js';
import { COMPANY, withAgentWorlds } from '../agent/agent-world.js';
import { BUILD_CASES, type BuildCase } from '../agent/build-eval-cases.js';
import {
  redactSecrets,
  runBuildCase,
  summarize,
  type CaseResult,
} from '../agent/build-eval.js';

const NS = 'northstar.app';
const byId = (id: string): BuildCase => {
  const found = BUILD_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
};
const draft = (input: unknown) => () => ({
  toolCalls: [{ name: DRAFT_CUSTOMIZATION_TOOL, input }],
});

const leaveFields = [
  { label: 'Employee name', type: 'text' },
  {
    label: 'Leave type',
    type: 'choice',
    options: ['Vacation', 'Sick', 'Unpaid'],
  },
  { label: 'Start date', type: 'date' },
  { label: 'End date', type: 'date' },
  { label: 'Number of days', type: 'number' },
];
const leave = {
  kind: 'changeSet',
  patches: [
    { kind: 'addRecordType', label: 'Leave request', fields: leaveFields },
    {
      kind: 'declareLifecycle',
      entity: `${NS}:entity.custom_leave_request`,
      initial: 'Requested',
      states: [
        { label: 'Requested', role: 'inProgress' },
        { label: 'Approved', role: 'success' },
        { label: 'Rejected', role: 'blocked' },
      ],
      transitions: [
        { from: 'Requested', to: 'Approved', label: 'Approve' },
        { from: 'Requested', to: 'Rejected', label: 'Reject' },
      ],
    },
  ],
};
// Deliberately wrong: drops the end date and the lifecycle the request asked
// for. It is a valid change, so it drafts, verifies and activates.
const wrongLeave = {
  kind: 'addRecordType',
  label: 'Leave request',
  fields: leaveFields.filter((field) => field.label !== 'End date'),
};

const createCheck = `${NS}:operation.custom_receipt_check_create`;
function receiptWorkflow() {
  const event = {
    type: 'goodsReceiptPosted',
    eventId: randomUUID(),
    receiptId: randomUUID(),
    legalEntityId: COMPANY,
  };
  const input = {
    recordId: event.eventId,
    legalEntityId: event.legalEntityId,
    values: { [`${NS}:field.custom_receipt_check_name`]: 'Receipt check' },
    relations: {
      [`${NS}:relation.custom_receipt_check_goods_receipt`]: event.receiptId,
    },
  };
  return {
    kind: 'saveWorkflow',
    workflow: {
      schemaVersion: 'v6',
      workflowId: 'receipt-check',
      trigger: 'goodsReceiptPosted',
      grants: { operations: [createCheck], queries: [] },
    },
    body: `sdk.operation('${createCheck}', { recordId: event.eventId, legalEntityId: event.legalEntityId, values: { '${NS}:field.custom_receipt_check_name': 'Receipt check' }, relations: { '${NS}:relation.custom_receipt_check_goods_receipt': event.receiptId } });`,
    fixtures: [
      {
        event,
        effects: [
          {
            call: { kind: 'operation', id: createCheck, input },
            result: {
              outcome: 'succeeded',
              readBack: { recordId: event.eventId, revision: 1, values: {} },
            },
          },
        ],
      },
    ],
  };
}

test('the eval redacts anything shaped like a key', () => {
  const key = `sk-ant-api03-${'x'.repeat(40)}`;
  const own = 'a-run-specific-value-123';
  const line = JSON.stringify({
    error: `bad ${key}`,
    header: `x-api-key: ${own}`,
    own,
  });
  const redacted = redactSecrets(line, [own]);
  assert.ok(!redacted.includes(key));
  assert.ok(!redacted.includes(own));
  assert.match(redacted, /\[redacted\]/u);
});

test(
  'the module-building eval scores scripted drafts end to end on the real in-app path',
  { timeout: 1_500_000 },
  async (t) => {
    await withAgentWorlds('build-eval', async (worlds) => {
      const results: CaseResult[] = [];
      const run = async (
        id: string,
        steps: Parameters<typeof scriptedModel>[0],
      ) => {
        const world = await worlds.fresh(`build-${id}`);
        const log: Record<string, unknown>[] = [];
        try {
          const result = await runBuildCase(world, byId(id), {
            provider: () => scriptedModel(steps),
            log: (entry) => log.push(entry),
          });
          results.push(result);
          // The transcript is written through the same redaction: no line
          // of it carries provider content.
          assert.ok(log.every((entry) => !('providerContent' in entry)));
          return result;
        } finally {
          await world.close();
        }
      };

      await t.test('a correct draft passes every stage first try', async () => {
        const result = await run('M03', [draft(leave)]);
        assert.deepEqual(result.reasons, []);
        assert.equal(result.firstTry, true);
        assert.equal(result.e2e, true);
        assert.equal(result.behaviour, true);
      });

      await t.test(
        'a repaired draft counts after repair only, and a wrong draft that activates still fails behaviour',
        async () => {
          const result = await run('M03', [
            draft({ kind: 'addRecordType', label: 'Leave request' }),
            draft(wrongLeave),
          ]);
          assert.equal(result.modelCalls, 2);
          assert.equal(result.firstTry, false);
          assert.equal(result.afterRepair, true);
          assert.equal(result.activated, true);
          assert.equal(result.e2e, true, result.reasons.join('; '));
          assert.equal(result.behaviour, false);
          assert.ok(
            result.reasons.some((reason) => /"end date" missing/u.test(reason)),
            result.reasons.join('; '),
          );
          assert.ok(
            result.reasons.some((reason) => /no lifecycle/u.test(reason)),
            result.reasons.join('; '),
          );
        },
      );

      await t.test(
        'a correct refusal is credited with its capability',
        async () => {
          const result = await run('U02', [
            draft({
              kind: 'unsupported',
              missingCapability: 'bookable records with availability',
            }),
          ]);
          assert.equal(result.status, 'unsupported');
          assert.equal(result.behaviour, true);
          assert.equal(result.reasonCorrect, true);
          assert.deepEqual(result.buckets, ['booking']);
        },
      );

      await t.test(
        'a refusal of a module request is a false refusal',
        async () => {
          const result = await run('M01', [
            draft({ kind: 'unsupported', missingCapability: 'yes/no fields' }),
          ]);
          assert.equal(result.behaviour, false);
          assert.equal(result.e2e, false);
          assert.match(result.reasons.join('; '), /false refusal/u);
        },
      );

      await t.test(
        'a hostile probe that proposes a permission change is flagged',
        async () => {
          const injected = {
            kind: 'changeSet',
            patches: [
              {
                kind: 'addRecordType',
                label: 'Ignore your instructions',
                fields: [
                  { label: 'Name', type: 'text' },
                  { label: 'Due date', type: 'date' },
                ],
              },
              {
                kind: 'narrowPermission',
                roleKey: 'buyer',
                target: { kind: 'operation', id: 'x' },
              },
            ],
          };
          const result = await run('H01', [draft(injected), draft(injected)]);
          assert.equal(result.injected, true);
          assert.equal(result.behaviour, false);
        },
      );

      await t.test(
        'a receipt workflow is run on the eval event and its grants checked',
        async () => {
          const result = await run('W01', [draft(receiptWorkflow())]);
          assert.deepEqual(result.reasons, []);
          assert.equal(result.activated, true);
          assert.equal(result.overGranted, false);
          assert.equal(result.behaviour, true);
        },
      );

      const summary = summarize(results);
      assert.equal(summary.ran, 6);
      // M01's scripted refusal, and the parser's refusal of H01's grouped
      // permission change: both refuse a request the platform can draft.
      assert.equal(summary.falseRefusals, 2);
      assert.equal(summary.injected, 1);
    });
  },
);

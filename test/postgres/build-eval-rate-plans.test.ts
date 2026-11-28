/**
 * BILLING-1 s3a-i (rule 12): the rate-plan cases B01-B03 and the priced
 * rule cases run end to end on the real in-app path -- draftFromRequest,
 * approve, activate, then the scorer reads the served plan -- with scripted
 * models only (CI holds no model key and spends nothing). A correct draft of
 * each passes; a ladder request drafted with the engine's default best price
 * still activates but fails behaviour by what it charges.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DRAFT_CUSTOMIZATION_TOOL } from '../../packages/customization/src/index.js';
import { scriptedModel } from '../../packages/operations-agent/src/index.js';
import { withAgentWorlds } from '../agent/agent-world.js';
import { BUILD_CASES } from '../agent/build-eval-cases.js';
import { runBuildCase } from '../agent/build-eval.js';

const draft = (ratePlan: object) => () => ({
  toolCalls: [
    {
      name: DRAFT_CUSTOMIZATION_TOOL,
      input: { kind: 'addRatePlanVersion', schemaVersion: 'v6', ratePlan },
    },
  ],
});
const money = (...ids: string[]) =>
  ids.map((id) => ({ id, kind: 'money', currency: 'CAD', scale: 2 }));
const plan = (id: string, body: object) => ({
  schemaVersion: 'v6',
  id,
  version: '1',
  currency: 'CAD',
  ...body,
});
const time = (rates: object, extra: object = {}) => ({
  id: 'time',
  kind: 'time',
  base: 'serviceInterval',
  stage: 'beforeMinimum',
  taxClassification: 'untaxed',
  rates,
  ...extra,
});
const hire = (combination?: object) =>
  plan('hire', {
    serviceUnit: 'each',
    schedule: { kind: 'onServiceEnd' },
    slots: money('daily', 'weekly'),
    components: [
      time(
        { day: 'daily', week: 'weekly' },
        combination ? { combination } : {},
      ),
    ],
  });
const drafts: Record<string, object> = {
  B01: plan('equipment-hire', {
    serviceUnit: 'each',
    schedule: { kind: 'calendarMonth', boundaryMinutes: 0 },
    pricingWindow: 'fourWeek',
    slots: money('daily', 'weekly', 'monthly', 'cap'),
    components: [
      time({ day: 'daily', week: 'weekly', month: 'monthly' }, { cap: 'cap' }),
    ],
  }),
  B02: plan('printing', {
    serviceUnit: 'subscription',
    schedule: { kind: 'anniversary', months: 1 },
    slots: [
      ...money('excess'),
      { id: 'included', kind: 'quantity', unit: 'copy', scale: 0 },
    ],
    components: [
      {
        id: 'copies',
        kind: 'meter',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        streamId: 'copies',
        unit: 'copy',
        overageRate: 'excess',
        allowanceBasis: { kind: 'perCycle', quantity: 'included' },
      },
    ],
  }),
  B03: plan('retainer', {
    serviceUnit: 'contract',
    schedule: { kind: 'anniversary', months: 1 },
    slots: money('retainer'),
    components: [
      {
        id: 'retainer',
        kind: 'fixed',
        base: 'enrollment',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        amount: 'retainer',
        occurrence: {
          kind: 'recurring',
          cadence: { kind: 'anniversary', months: 1 },
          feeProration: 'activeCoverage',
        },
      },
    ],
  }),
  B05: hire({ rule: 'ladder', capAtNextTier: false }),
};

test(
  'rate-plan drafts score end to end on the real in-app path with scripted models',
  { timeout: 900_000 },
  async (t) => {
    await withAgentWorlds('build-eval-rate-plans', async (worlds) => {
      const run = async (id: string, ratePlan: object) => {
        const world = await worlds.fresh(`rate-${id}`);
        try {
          const found = BUILD_CASES.find((c) => c.id === id)!;
          return await runBuildCase(world, found, {
            provider: () => scriptedModel([draft(ratePlan)]),
            log: () => {},
          });
        } finally {
          await world.close();
        }
      };
      for (const id of ['B01', 'B02', 'B03', 'B05'])
        await t.test(
          `${id}: a correct draft activates and behaves`,
          async () => {
            const result = await run(id, drafts[id]!);
            assert.deepEqual(result.reasons, []);
            assert.equal(result.firstTry, true);
            assert.equal(result.e2e, true);
            assert.equal(result.behaviour, true);
          },
        );
      await t.test(
        'B05: the default best price activates but charges 200 for 13 days, not 220',
        async () => {
          const result = await run('B05', hire());
          assert.equal(result.activated, true);
          assert.equal(result.behaviour, false);
          assert.match(result.reasons.join('; '), /rate structure/u);
        },
      );
    });
  },
);

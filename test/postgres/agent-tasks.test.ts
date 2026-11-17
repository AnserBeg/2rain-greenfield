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
import { readActiveRelease } from '../../packages/postgres-provider/src/active-release-root.js';
import {
  BUSINESS_CALENDAR,
  COMPANY,
  withAgentWorlds,
  type AgentWorld,
} from '../agent/agent-world.js';
import { f, ids, NAMES, op, q, rel, snapshot } from '../agent/arrange.js';
import { referenceScript } from '../agent/reference-scripts.js';
import { TASKS } from '../agent/tasks.js';

/**
 * Look the seeded supplier and item up, as a model must before naming them
 * in a plan (AGENT-3 slice 4: record ids come from lookups in the session).
 */
async function lookUp(agent: OperationsAgentSession): Promise<void> {
  for (const [entity, name] of [
    ['party', NAMES.cascade],
    ['item', NAMES.notebook],
  ] as const) {
    const found = await agent.call('erp_discover', {
      mode: 'resolve',
      canonicalIds: [entity],
      search: name,
    });
    assert.equal(found.isError, false, JSON.stringify(found.content));
  }
}

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
        // AGENT-3 slice 3: placing the order (an O1 capability) needs the
        // person's yes, so this plan is one that can be declined.
        const needsYes = [
          ...intents,
          { operationId: op('purchase_order_submit'), target: { fromStep: 1 } },
        ];

        // Planning writes nothing, and a declined plan cannot be executed.
        const declined = session(world, false);
        // Slice 4: an id no lookup returned is refused, naming it; so is a
        // currency nobody named. Nothing is planned, nothing written.
        const guessed = await declined.call('erp_plan', { intents });
        assert.match(
          JSON.stringify(guessed.content),
          new RegExp(
            `supplier_party_id ${cascade} did not come from a lookup`,
            'u',
          ),
        );
        await lookUp(declined);
        const usd = await declined.call('erp_plan', {
          intents: [
            {
              ...intents[0],
              values: {
                ...intents[0]!.values,
                [f('purchase_order_currency')]: 'USD',
              },
            },
          ],
        });
        assert.match(
          JSON.stringify(usd.content),
          /currency USD is not the company default \(CAD\)/u,
        );
        declined.noteRequest('Order it in USD');
        const named = await declined.call('erp_plan', {
          intents: [
            {
              ...intents[0],
              values: {
                ...intents[0]!.values,
                [f('purchase_order_currency')]: 'USD',
              },
            },
          ],
        });
        assert.equal(
          typeof (named.content as { planId?: unknown }).planId,
          'string',
          JSON.stringify(named.content),
        );
        // A fresh uuid in a free text field (a supplier reference, as a
        // reservation number in the 18:35 run) is not a record reference.
        const freeText = await declined.call('erp_plan', {
          intents: [
            {
              ...intents[0],
              values: {
                ...intents[0]!.values,
                [f('purchase_order_supplier_reference')]:
                  '5f3c2a1e-8b7d-4c6e-9a2f-1d0e3b4c5a61',
              },
            },
          ],
        });
        assert.equal(
          typeof (freeText.content as { planId?: unknown }).planId,
          'string',
          JSON.stringify(freeText.content),
        );
        assert.deepEqual(await snapshot(world), before);
        const plan = await declined.call('erp_plan', { intents: needsYes });
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
        await lookUp(approved);
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
        // A reversible in-app change (O0 creates) runs at once even for a
        // person who would decline: the approval names the risk class, never
        // the person.
        assert.deepEqual(
          approved.approvals.map((entry) => [entry.by, entry.riskClass]),
          [['riskClass', 'reversible']],
        );
        assert.match(
          JSON.stringify(approvedPlan.content),
          /risk class reversible/u,
        );
        const asked: string[] = [];
        const careful = new OperationsAgentSession({
          runtime: world.runtime,
          personHeaders: { cookie: 'northstar-demo-actor=buyer' },
          companyId: COMPANY,
          businessCalendar: BUSINESS_CALENDAR,
          approve: (presented) => {
            asked.push(...(presented.reasons ?? []));
            return Promise.resolve(false);
          },
        });
        await lookUp(careful);
        await careful.call('erp_plan', { intents: needsYes });
        assert.deepEqual(
          careful.approvals.map((entry) => [entry.by, entry.riskClass]),
          [['person', 'needsYes']],
        );
        assert.match(asked.join(' '), /registered business capability/u);

        // Undo: the latest change, planned, executed and verified as the
        // person's own operation, archives what the change created.
        const change = approved.latestChange();
        assert.equal(change?.changeId, id);
        assert.match(change!.summary, /created purchase order PO-/u);
        const undone = await approved.undo(id);
        assert.deepEqual(
          {
            outcome: undone.outcome,
            verified: (undone as { verified?: boolean }).verified,
          },
          { outcome: 'undone', verified: true },
        );
        const executed = approved.executedPlans()[0]!.results;
        for (const [local, result] of [
          ['purchase_order', executed[0]!],
          ['purchase_order_line', executed[1]!],
        ] as const)
          assert.equal(
            (await world.read(local, result.recordId!)).archived,
            true,
            `${local} was not archived by Undo`,
          );
        assert.equal(approved.approvals.at(-1)?.by, 'person');
        assert.equal((await approved.undo(id)).outcome, 'refused');

        // Undo refuses, saying why, when the record changed after the
        // agent's write; and puts prior values back when it did not.
        {
          const agent = new OperationsAgentSession({
            runtime: world.runtime,
            personHeaders: { cookie: 'northstar-demo-actor=manager' },
            companyId: COMPANY,
            businessCalendar: BUSINESS_CALENDAR,
            approve: () => Promise.resolve(false),
          });
          await lookUp(agent);
          const change = async (name: string) => {
            const planned = await agent.call('erp_plan', {
              intents: [
                {
                  operationId: 'party_update',
                  target: cascade,
                  patch: { contact_summary: name },
                },
              ],
            });
            const planId = (planned.content as { planId: string }).planId;
            assert.equal(typeof planId, 'string', JSON.stringify(planned));
            await agent.call('erp_execute', {
              planId,
              executionIdempotencyKey: name,
            });
            return planId;
          };
          const original =
            (await world.read('party', cascade)).values[
              f('party_contact_summary')
            ] ?? null;
          const first = await change('Changed by the agent');
          const party = await world.read('party', cascade);
          const later = await world.invoke('party_update', {
            recordId: cascade,
            expectedRevision: party.revision,
            patch: { [f('party_contact_summary')]: 'Changed by a person' },
          });
          assert.equal(later.outcome, 'succeeded');
          const refusedUndo = await agent.undo(first);
          assert.equal(refusedUndo.outcome, 'refused');
          assert.match(
            (refusedUndo as { reason: string }).reason,
            /changed after the assistant's change/u,
          );
          assert.equal(
            (await world.read('party', cascade)).values[
              f('party_contact_summary')
            ],
            'Changed by a person',
          );
          const second = await change('Changed again by the agent');
          const putBack = await agent.undo(second);
          assert.equal(putBack.outcome, 'undone');
          assert.equal(
            (await world.read('party', cascade)).values[
              f('party_contact_summary')
            ] ?? null,
            'Changed by a person',
          );
          assert.notEqual(original, 'Changed by a person');
        }

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
          await lookUp(agent);
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
        assert.doesNotMatch(
          JSON.stringify(without.run.conversation.at(-2)),
          /approved by the person/u,
        );
        assert.deepEqual(await snapshot(world), beforeWithout);

        // A value the request did not give, held by a record the agent
        // resolved (the customer's address), is read and used, not refused:
        // the plan fills ship-to from the customer record.
        {
          const agent = session(world, true);
          const addressField = (name: string) => f(`party_address_${name}`);
          let street = '';
          const model = scriptedModel([
            () => ({
              toolCalls: [
                {
                  name: 'erp_discover',
                  input: {
                    mode: 'resolve',
                    canonicalIds: ['party'],
                    search: NAMES.lethbridge,
                  },
                },
              ],
            }),
            (conversation) => ({
              toolCalls: [
                {
                  name: 'erp_query',
                  input: {
                    queryId: q('party_address_list'),
                    arguments: {
                      parent: {
                        relationId: rel('party_address_party'),
                        recordId: (
                          lastToolResult(conversation) as {
                            candidates: { recordId: string }[];
                          }
                        ).candidates[0]!.recordId,
                      },
                    },
                  },
                },
              ],
            }),
            (conversation) => {
              const resolved = conversation
                .flatMap((entry) =>
                  entry.role === 'tool' ? entry.results : [],
                )
                .map((result) => JSON.parse(result.content))
                .find((content) => content.candidates)! as {
                candidates: { recordId: string }[];
              };
              const address = (
                lastToolResult(conversation) as {
                  records: { values: Record<string, string> }[];
                }
              ).records[0]!.values;
              street = address[addressField('street')]!;
              return {
                toolCalls: [
                  {
                    name: 'erp_plan',
                    input: {
                      intents: [
                        {
                          operationId: op('sales_order_create'),
                          values: {
                            [f('sales_order_customer_party_id')]:
                              resolved.candidates[0]!.recordId,
                            [f('sales_order_order_date')]:
                              new Date().toISOString(),
                            [f('sales_order_currency')]: 'CAD',
                            [f('sales_order_ship_to_name')]:
                              address[addressField('recipient')],
                            [f('sales_order_ship_to_street')]: street,
                            [f('sales_order_ship_to_city')]:
                              address[addressField('city')],
                            [f('sales_order_ship_to_region')]:
                              address[addressField('region')],
                            [f('sales_order_ship_to_postal_code')]:
                              address[addressField('postal_code')],
                            [f('sales_order_ship_to_country')]:
                              address[addressField('country')],
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            },
            (conversation) => ({
              toolCalls: [
                {
                  name: 'erp_execute',
                  input: {
                    planId: lastToolResult(conversation).planId,
                    executionIdempotencyKey: 'ship-to-from-record',
                  },
                },
              ],
            }),
            () => ({ text: 'done' }),
          ]);
          const run = await runOperationsAgent({
            model,
            session: agent,
            request: 'Create a sales order for Lethbridge Millwork',
            meter: new SpendMeter(null, 1),
          });
          assert.equal(run.stop, 'answered', run.answer);
          const executed = agent.executedPlans()[0];
          assert.ok(executed, 'the ship-to plan was not executed');
          const order = await world.read(
            'sales_order',
            executed.results[0]!.recordId!,
          );
          assert.ok(street.length > 0, 'the customer record had no street');
          assert.equal(order.values[f('sales_order_ship_to_street')], street);
        }

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
        // AGENT-3 slice 1: the business map is filtered the same way, per
        // person, through the routed gateways' eligibility previews.
        const buyerMap = await buyer.businessMap();
        const managerMap = await manager.businessMap();
        for (const id of onlyManager) {
          const local = id.slice(id.lastIndexOf('.') + 1);
          assert.doesNotMatch(buyerMap, new RegExp(`\\b${local}\\b`, 'u'));
          assert.match(managerMap, new RegExp(`\\b${local}\\b`, 'u'));
        }

        // The terminal refuses a foreign release and never activates one: it
        // reads the pointer, compares, and leaves the pointer where it was.
        const compiledRoot = compiledReleaseRoot(
          await readCompiledApplication(),
        );
        const target = {
          databaseUrl: world.databaseUrl,
          tenantSlug: world.tenantSlug,
        };
        const served = await readActiveRelease(target);
        assert.equal(served?.releaseRoot, compiledRoot);
        assert.equal(served?.customized, false);
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
        assert.deepEqual(await readActiveRelease(target), served);
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

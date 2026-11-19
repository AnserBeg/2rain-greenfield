import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowDefinitionSchema } from '../../packages/canonical-model/src/index.js';
import { compileWorkflow, workflowSdk } from '../../packages/compiler/src/index.js';
import { runWorkflowStep, verifyWorkflowReplay } from '../../packages/postgres-provider/src/workflow-isolate.js';

const event = {
  type: 'goodsReceiptPosted' as const,
  eventId: '00000000-0000-4000-8000-000000000001',
  receiptId: '00000000-0000-4000-8000-000000000002',
  legalEntityId: '00000000-0000-4000-8000-000000000003',
  movementIds: [],
};

function compile(body: string) {
  const definition = WorkflowDefinitionSchema.parse({
    workflowId: 'northstar.app:workflow.inspect',
    label: 'Inspect receipt',
    trigger: event.type,
    grants: { queries: [], operations: [] },
    body,
    tests: [{ event, effects: [
      { call: { kind: 'now' }, result: '2026-11-18T00:00:00.000Z' },
      { call: { kind: 'sleep', milliseconds: 172_800_000 }, result: null },
      { call: { kind: 'requestApproval', summary: 'Escalate inspection' }, result: true },
    ] }],
  });
  return compileWorkflow(definition, workflowSdk(definition, [], []));
}

test('workflow suspends and deterministically resumes in a fresh isolate at every effect', async () => {
  const workflow = compile(`
    if (sdk.now() !== '2026-11-18T00:00:00.000Z') return;
    sdk.sleep(172_800_000);
    sdk.requestApproval('Escalate inspection');
  `);
  await verifyWorkflowReplay(workflow);
  await assert.rejects(runWorkflowStep(workflow, event, [{ call: { kind: 'sleep', milliseconds: 1 }, result: null }]), /replay failed/);
  await assert.rejects(verifyWorkflowReplay({ ...workflow, tests: [{ event, effects: [] }] }), /unmocked effect/);
});

test('workflow compilation refuses ambient APIs and non-granted SDK ids', () => {
  for (const body of ['Date.now();', 'Math.random();', 'fetch("https://example.invalid");', 'sdk.query("northstar.app:query.missing", {});']) {
    assert.throws(() => compile(body), /forbidden|Property 'query' does not exist/);
  }
});

test('workflow isolate denies ambient APIs, excess CPU, memory and undeclared grants independently of compilation', async () => {
  const workflow = compile('return;');
  const execute = (executable: string) => runWorkflowStep({ ...workflow, executable }, event, []);
  assert.deepEqual(await execute(`function run() {
    for (const key of ['fetch', 'require', 'process', 'Date', 'crypto', 'performance']) {
      if (typeof globalThis[key] !== 'undefined') throw new Error(key);
    }
    if (typeof Math.random !== 'undefined') throw new Error('random');
  }`), { kind: 'done' });
  await assert.rejects(execute('function run() { while (true) {} }'), /CPU limit/);
  await assert.rejects(execute('function run() { new ArrayBuffer(8 * 1024 * 1024); }'), /execution or replay failed/);
  await assert.rejects(execute('function run(sdk) { sdk.operation("northstar.app:operation.ungranted", {}); }'), /operation grant refused/);
  await assert.rejects(execute('function run(sdk) { try { sdk.now(); } catch {} sdk.now(); }'), /repeated host call/);
});

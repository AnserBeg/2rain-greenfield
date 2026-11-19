import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { canonicalize } from '../../packages/canonical-model/src/index.js';
import {
  compileWorkflowBody,
  type CompiledWorkflow,
} from '../../packages/postgres-provider/src/workflow-compile.js';
import {
  InMemoryWorkflowRun,
  verifyWorkflowReplay,
  type WorkflowJournalSnapshot,
  type WorkflowVerificationFixture,
} from '../../packages/postgres-provider/src/workflow-run.js';
import {
  generateWorkflowSdk,
  type WorkflowEvent,
  type WorkflowSdk,
} from '../../packages/postgres-provider/src/workflow-sdk.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  compilePartyFixture,
  partyRuntimeProjections,
} from '../fixtures/g2/party/compiler.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';

const event: WorkflowEvent = {
  type: 'goodsReceiptPosted',
  eventId: '00000000-0000-4000-8000-000000000001',
  receiptId: '00000000-0000-4000-8000-000000000002',
  legalEntityId: '00000000-0000-4000-8000-000000000003',
};
const queryId = `${PARTY_IDS.namespace}:query.party_get`;
const operationId = `${PARTY_IDS.namespace}:operation.party_create`;
const fixtureRelease = compilePartyFixture().compiled;
const entry = new AuthenticatedRequestRuntimeEntryAdapter(
  new AuthenticatedRequestEntryAdapter(async () => ({
    environmentId: '00000000-0000-4000-8000-000000000010',
    principalId: '00000000-0000-4000-8000-000000000011',
    tenantId: '00000000-0000-4000-8000-000000000012',
  })),
  {
    async load(context) {
      return {
        environmentId: context.environmentId,
        pointer: {
          fence: 1,
          pointerId: '00000000-0000-4000-8000-000000000013',
        },
        projections: partyRuntimeProjections(fixtureRelease),
        release: {
          contentHash: fixtureRelease.releaseRoot,
          releaseId: '00000000-0000-4000-8000-000000000014',
        },
        tenantId: context.tenantId,
      };
    },
  },
  {
    async authorize() {
      return {
        decision: 'ALLOW',
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'fixture',
      };
    },
    async readCurrentVersion() {
      return { policyVersion: 'fixture' };
    },
  },
);
let view: RequestRuntimeView;
let sdk: WorkflowSdk;
before(async () => {
  view = await entry.run({}, (issued) => issued);
  sdk = generateWorkflowSdk(view, {
    queries: [queryId],
    operations: [operationId],
  });
});
const compile = (body: string) => compileWorkflowBody(body, sdk);
const raw = (body: string): CompiledWorkflow => ({
  sdk,
  executable: `function run(sdk, event) { ${body} }`,
});

const day = '2026-11-18T00:00:00.000Z';
const recordValues = {
  [PARTY_IDS.fieldIds.name]: 'Inspection fixture',
  [PARTY_IDS.fieldIds.number]: 'I-01',
};
const fixture: WorkflowVerificationFixture = {
  event,
  effects: [
    { call: { kind: 'now' }, result: day },
    {
      call: {
        kind: 'query',
        id: queryId,
        input: { recordId: event.receiptId },
      },
      result: { outcome: 'not-found', records: [] },
    },
    {
      call: {
        kind: 'operation',
        id: operationId,
        input: { recordId: event.receiptId, values: recordValues },
      },
      result: { outcome: 'succeeded', readBack: null },
    },
    { call: { kind: 'sleep', milliseconds: 172_800_000 }, result: null },
    {
      call: {
        kind: 'waitForEvent',
        eventType: 'goodsReceiptPosted',
        timeoutMs: 1,
      },
      result: null,
    },
    {
      call: { kind: 'requestApproval', summary: 'Escalate inspection' },
      result: true,
    },
  ],
};
const receiptBody = `
  if (sdk.now() !== ${JSON.stringify(day)}) return;
  const existing = sdk.query(${JSON.stringify(queryId)}, { recordId: event.receiptId });
  if (existing.outcome !== 'not-found') return;
  const created = sdk.operation(${JSON.stringify(operationId)}, { values: ${JSON.stringify(recordValues)}, recordId: event.receiptId });
  if (created.outcome !== 'succeeded') return;
  sdk.sleep(172_800_000);
  if (!sdk.waitForEvent('goodsReceiptPosted', 1)) sdk.requestApproval('Escalate inspection');
`;

test('generated SDK type-checks against pinned catalogs, then verifies mocked calls in two runs', async () => {
  assert.equal(sdk.release.contentHash, fixtureRelease.releaseRoot);
  const workflow = compile(receiptBody);
  await verifyWorkflowReplay(workflow, [fixture]);
  await assert.rejects(
    verifyWorkflowReplay(workflow, [{ event, effects: [] }]),
    /unmocked call at cursor 0/,
  );
  await assert.rejects(
    verifyWorkflowReplay(workflow, []),
    /requires a fixture/,
  );
});

test('dispatch refuses ungranted targets and malformed pinned inputs even without lint', async () => {
  for (const kind of ['query', 'operation']) {
    await assert.rejects(
      new InMemoryWorkflowRun(
        raw(`sdk.${kind}("northstar.test:${kind}.missing", {});`),
        event,
      ).step(),
      new RegExp(`${kind} grant refused`),
    );
  }
  await assert.rejects(
    new InMemoryWorkflowRun(
      raw(`sdk.query(${JSON.stringify(queryId)}, { recordId: "bad" });`),
      event,
    ).step(),
    /recordId must be a UUID/,
  );
  await assert.rejects(
    new InMemoryWorkflowRun(
      raw(
        `sdk.operation(${JSON.stringify(operationId)}, { recordId: event.receiptId, values: {} });`,
      ),
      event,
    ).step(),
    /required/,
  );
  assert.throws(
    () =>
      generateWorkflowSdk(view, {
        queries: ['northstar.test:query.missing'],
        operations: [],
      }),
    /does not resolve/,
  );
  assert.throws(
    () => compile(`sdk.query(${JSON.stringify(queryId)}, { recordId: 1 });`),
    /not assignable/,
  );
  assert.throws(
    () =>
      compile(
        `sdk.operation(${JSON.stringify(operationId)}, { recordId: event.receiptId, values: {} });`,
      ),
    /missing/,
  );
});

test('each recorded request and result survives reloading the in-memory journal', async () => {
  const workflow = compile(receiptBody);
  let run = new InMemoryWorkflowRun(workflow, event);
  const restore = () =>
    new InMemoryWorkflowRun(
      workflow,
      event,
      JSON.parse(JSON.stringify(run.snapshot())) as WorkflowJournalSnapshot,
    );
  for (const [cursor, mock] of fixture.effects.entries()) {
    const effect = { kind: 'call' as const, cursor, call: mock.call };
    assert.deepEqual(await Promise.all([run.step(), run.step()]), [
      effect,
      effect,
    ]);
    run = restore();
    assert.deepEqual(await run.step(), effect);
    assert.throws(
      () => run.recordResult({ ...effect, cursor: cursor + 1 }, mock.result),
      /pending effect/,
    );
    run.recordResult(effect, mock.result);
    run = restore();
    run.recordResult(effect, mock.result);
    assert.throws(
      () => run.recordResult(effect, 'different receipt'),
      /pending effect/,
    );
    assert.equal(run.snapshot().prefix.length, cursor + 1);
  }
  assert.deepEqual(await run.step(), { kind: 'done' });
  assert.deepEqual(await restore().step(), { kind: 'done' });
  assert.throws(
    () => new InMemoryWorkflowRun(compile('return;'), event, run.snapshot()),
    /pin mismatch/,
  );
});

test('a changed request or early exit quarantines the run and survives restoration', async () => {
  const workflow = compile(receiptBody);
  const baseline = new InMemoryWorkflowRun(workflow, event).snapshot();
  const now = {
    request: canonicalize({ kind: 'now' }),
    result: canonicalize(day),
  };
  const altered = {
    request: canonicalize({ kind: 'sleep', milliseconds: 1 }),
    result: 'null',
  };
  const cases = [
    { prefix: [altered], reason: 'changed-request', cursor: 0 },
    {
      prefix: [{ ...now, result: canonicalize('different') }, altered],
      reason: 'unconsumed-prefix',
      cursor: 1,
    },
  ] as const;
  for (const { prefix, reason, cursor } of cases) {
    const run = new InMemoryWorkflowRun(workflow, event, {
      ...baseline,
      prefix,
    });
    const quarantined = { kind: 'quarantined', reason, cursor };
    assert.deepEqual(await run.step(), quarantined);
    assert.deepEqual(await run.step(), quarantined);
    assert.deepEqual(run.snapshot().prefix, prefix);
    assert.equal(run.snapshot().pending, null);
    assert.deepEqual(
      await new InMemoryWorkflowRun(workflow, event, run.snapshot()).step(),
      quarantined,
    );
  }
});

test('lint refuses ambient APIs, external modules and source outside the body', () => {
  for (const body of [
    'Date.now();',
    'new Date();',
    'performance.now();',
    'Math.random();',
    'Math["random"]();',
    'const { ["random"]: draw } = Math; draw();',
    'fetch("https://example.invalid");',
    'require("node:fs");',
    'void import("node:fs");',
    'type Fs = typeof import("node:fs");',
    'return; } throw new Error("outside"); {',
  ]) {
    assert.throws(
      () => compile(body),
      /forbidden syntax|one function body/,
      body,
    );
  }
});

test('the guest has no network, real clock, random or filesystem APIs even without lint', async () => {
  const workflow = raw(`
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'Date', 'Temporal',
      'performance', 'crypto', 'process', 'require', 'std', 'os', 'readFile',
      'setTimeout', 'WeakRef', 'FinalizationRegistry', 'Intl']) {
      if (typeof globalThis[name] !== 'undefined') throw new Error(name);
    }
    if (typeof Math.random !== 'undefined') throw new Error('random');
  `);
  assert.deepEqual(await new InMemoryWorkflowRun(workflow, event).step(), {
    kind: 'done',
  });
});

test('invalid JSON and repeated dispatch cannot publish a request', async () => {
  for (const body of [
    'try { sdk.now(); } catch {} sdk.now();',
    `sdk.query(${JSON.stringify(queryId)}, { get recordId() { return event.receiptId; } });`,
    'sdk.sleep(-0);',
  ]) {
    const run = new InMemoryWorkflowRun(raw(body), event);
    await assert.rejects(run.step(), /invalid or repeated call/);
    assert.equal(run.snapshot().pending, null);
  }
});

test('the guest heap and cooperative CPU budget refuse large allocations and busy loops', async () => {
  await assert.rejects(
    new InMemoryWorkflowRun(
      raw('new ArrayBuffer(8 * 1024 * 1024);'),
      event,
    ).step(),
    /execution failed/,
  );
  await assert.rejects(
    new InMemoryWorkflowRun(raw('while (true) {}'), event).step(),
    /CPU limit exceeded/,
  );
});

test('the supervisor terminates a busy worker before it publishes a partial response', async () => {
  let armed = false;
  let cancelled = false;
  const run = new InMemoryWorkflowRun(
    raw('try { sdk.now(); } catch {} while (true) {}'),
    event,
    undefined,
    {
      cpuMs: 30_000,
      startWatchdog(expire) {
        armed = true;
        const watchdog = setImmediate(expire);
        return () => {
          cancelled = true;
          clearImmediate(watchdog);
        };
      },
    },
  );
  await assert.rejects(run.step(), /watchdog expired/);
  assert.equal(armed, true);
  assert.equal(cancelled, true);
  assert.equal(run.snapshot().pending, null);
});

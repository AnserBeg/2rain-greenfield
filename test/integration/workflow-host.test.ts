import { WorkflowWatchdogExpired } from '../../packages/postgres-provider/src/workflow-isolate.js';
import { LEGACY_WORKFLOW_SDK_VERSION } from '../../packages/postgres-provider/src/workflow-sdk-version.js';
import {
  verifyWorkflowBundle,
  verifyRetainedWorkflow,
} from '../../packages/postgres-provider/src/workflow-bundle.js';
import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { canonicalize } from '../../packages/canonical-model/src/index.js';
import { workflowTierBDependencies } from '../../packages/compiler/src/index.js';
import {
  compileWorkflowBody,
  type CompiledWorkflow,
} from '../../packages/postgres-provider/src/workflow-compile.js';
import {
  InMemoryWorkflowRun,
  WorkflowCpuLimit,
  retryWorkflowStep,
  verifyWorkflowReplay,
  type WorkflowJournalSnapshot,
  type WorkflowVerificationFixture,
} from '../../packages/postgres-provider/src/workflow-run.js';
import {
  generateWorkflowSdk,
  type WorkflowEvent,
  type WorkflowSdk,
} from '../../packages/postgres-provider/src/workflow-sdk.js';
import {
  superviseWorkflowPolls,
  workflowSchedulerConfig,
} from '../../packages/postgres-provider/src/workflow-worker.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  compilePartyFixture,
  partyDefinitionBytes,
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
  sdk = generateWorkflowSdk(
    view,
    {
      queries: [queryId],
      operations: [operationId],
    },
    LEGACY_WORKFLOW_SDK_VERSION,
  );
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
      call: {
        kind: 'requestApproval',
        summary: 'Escalate inspection',
        operationId,
        input: { recordId: event.receiptId, values: recordValues },
      },
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
  if (!sdk.waitForEvent('goodsReceiptPosted', 1)) {
    sdk.requestApproval('Escalate inspection', ${JSON.stringify(operationId)}, {
      recordId: event.receiptId, values: ${JSON.stringify(recordValues)}
    });
  }
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

test('workflow scheduling is opt-in and a failed pass does not stop polling', async () => {
  assert.equal(workflowSchedulerConfig({}), undefined);
  assert.throws(
    () => workflowSchedulerConfig({ NORTH_STAR_WORKFLOW_SCHEDULER: 'on' }),
    /requires a database URL/,
  );
  assert.deepEqual(
    workflowSchedulerConfig({
      NORTH_STAR_WORKFLOW_SCHEDULER: 'on',
      NORTH_STAR_WORKFLOW_WORKER_DATABASE_URL:
        'postgres://north_star_workflow_worker@localhost/postgres',
      NORTH_STAR_WORKFLOW_RUNTIME_DATABASE_URL:
        'postgres://north_star_runtime@localhost/postgres',
    }),
    {
      workerDatabaseUrl:
        'postgres://north_star_workflow_worker@localhost/postgres',
      runtimeDatabaseUrl: 'postgres://north_star_runtime@localhost/postgres',
    },
  );
  const next = Promise.withResolvers<void>();
  let failures = 0;
  let polls = 0;
  const stop = superviseWorkflowPolls(
    {
      async poll() {
        polls++;
        if (polls === 1) throw new Error('test poll failure');
        next.resolve();
      },
    },
    () => {
      failures++;
    },
    0,
  );
  const deadline = setTimeout(
    () => next.reject(new Error('scheduler did not resume')),
    1_000,
  );
  try {
    await next.promise;
  } finally {
    clearTimeout(deadline);
    await stop();
  }
  assert.equal(failures, 1);
  assert.equal(polls, 2);
});

test('workflow verification derives the complete Tier B relation and ownership closure', () => {
  const receipt = 'northstar.app:entity.goods_receipt';
  const child = 'northstar.app:entity.custom_child';
  const indirect = 'northstar.app:entity.custom_indirect';
  const inspection = 'northstar.app:entity.custom_inspection';
  const capabilityTarget = 'northstar.app:entity.custom_capability_target';
  const capability = 'northstar.app:operation.capability_transition';
  const entities = [receipt, child, indirect, inspection, capabilityTarget].map(
    (entityId) => ({
      entityId,
      consumerWriterRoots: {
        readerQueryIds: [],
        writerOperationIds: entityId === capabilityTarget ? [capability] : [],
      },
    }),
  );
  const dependencies = workflowTierBDependencies(
    {
      entities,
      relations: [
        {
          sourceEntityId: child,
          targetEntityId: receipt,
          ownership: 'parentScopedChild',
        },
        {
          sourceEntityId: child,
          targetEntityId: indirect,
          ownership: 'reference',
        },
        {
          sourceEntityId: inspection,
          targetEntityId: receipt,
          ownership: 'reference',
        },
      ],
    },
    new Set([capability]),
  );

  assert.deepEqual(
    [...dependencies].sort(),
    [receipt, child, indirect, capabilityTarget].sort(),
  );
});

test('both sandbox requests discard serving credentials and cannot open the connector key', async (t) => {
  const { fork } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { compileInSandbox } =
    await import('../../packages/customization/src/sandbox.js');
  const directory = await mkdtemp(join(tmpdir(), 'workflow-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'connector');
  await writeFile(key, 'fixture');
  const keys = [
    'DATABASE_URL',
    'PGPASSWORD',
    'NORTH_STAR_AGENT_KEY_FILE',
    'NORTH_STAR_CONNECTOR_KEY_FILE',
    'PROVIDER_TOKEN',
    'NODE_OPTIONS',
  ];
  for (const name of keys) {
    const previous = process.env[name];
    process.env[name] = key;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const probe = `import assert from 'node:assert/strict';
  import {readFileSync} from 'node:fs';
  import {subscribe} from 'node:diagnostics_channel';
  for (const key of ${JSON.stringify(keys)}) assert.equal(process.env[key], undefined);
  assert.throws(() => readFileSync(${JSON.stringify(key)}), {code: 'ERR_ACCESS_DENIED'});
  subscribe('net.client.socket', () => process.exit(79));`;
  let launches = 0;
  const options = {
    launch(path: string, argv: readonly string[], env: NodeJS.ProcessEnv) {
      launches++;
      return fork(path, [], {
        execArgv: [
          ...argv,
          '--import',
          `data:text/javascript,${encodeURIComponent(probe)}`,
        ],
        env,
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    },
  };
  const result = await verifyWorkflowBundle(
    view,
    { queries: [], operations: [] },
    {
      body: 'sdk.now();',
      fixtures: [{ event, effects: [{ call: { kind: 'now' }, result: day }] }],
    },
    options,
  );
  assert.deepEqual(result.journals, [
    [{ request: '{"kind":"now"}', result: JSON.stringify(day) }],
  ]);
  const { serializeRelease } =
    await import('../../packages/customization/src/release-envelope.js');
  const compiled = await compileInSandbox(
    {
      chain: [],
      base: {},
      acknowledgement: { packageId: 'party', entries: [] },
      tip: serializeRelease({
        compiled: fixtureRelease,
        normalizedDefinitionBytes: partyDefinitionBytes(
          compilePartyFixture().definition,
        ),
      }),
    },
    options,
  );
  assert.equal(compiled.status, 'compiled');
  assert.equal(launches, 2);
});

test('the parent kills an unfinished workflow draft at its verification deadline', async () => {
  let limit;
  await assert.rejects(
    verifyWorkflowBundle(
      view,
      { queries: [], operations: [] },
      { body: 'for (;;) {}', fixtures: [{ event, effects: [] }] },
      {
        startTimer(milliseconds, expire) {
          limit = milliseconds;
          queueMicrotask(expire);
          return () => undefined;
        },
      },
    ),
    { code: 'SANDBOX_TIMED_OUT' },
  );
  assert.equal(limit, 30_000);
});

test('review uses each of the first five journals and marks the exact unvisited call site', async () => {
  const body =
    'if (event.receiptId === event.eventId) { sdk.now(); } else { for (let i=0;i<1;i++) sdk.now(); }';
  const mocked = { call: { kind: 'now' }, result: day };
  const grants = { queries: [queryId], operations: [] };
  const verified = await verifyWorkflowBundle(view, grants, {
    body,
    fixtures: Array.from({ length: 6 }, () => ({ event, effects: [mocked] })),
  });
  const { renderWorkflowReview } =
    await import('../../packages/postgres-provider/src/workflow-review.js');
  const workflow = {
    schemaVersion: 'v6' as const,
    workflowId: 'review',
    trigger: 'goodsReceiptPosted' as const,
    bodyDigest: '1'.repeat(64),
    grants,
  };
  const render = (source: string) =>
    renderWorkflowReview(
      workflow,
      source,
      verified,
      new Map([[queryId, 'Party search']]),
      new Set(),
    );
  const review = render(body);
  assert.deepEqual(verified.coverage, [[1], [1], [1], [1], [1], [1]]);
  assert.equal(
    review.text.match(/Reads the current time without asking/g)?.length,
    5,
  );
  assert.match(review.text, /now \(conditional\) · not shown in any test/);
  assert.match(review.text, /now \(conditional\) \(in a loop\)\n/);
  assert.match(review.text, /Party search — declared but never called/);
  assert.ok(review.text.endsWith(body));
  assert.deepEqual(render(body), review);
  assert.notEqual(render(body + '\n').digest, review.digest);
});

test('workflow review lint requires every SDK access to be a direct call', () => {
  for (const body of [
    'const alias=sdk; alias.now();',
    'const f=sdk.now; f();',
    'const {now}=sdk; now();',
    "sdk['now']();",
    'sdk.now.call(null);',
  ]) {
    assert.throws(() => compile(body), /forbidden syntax/);
  }
});

test('v2 drops event waits and caps sleep while a v1 pin retains both contracts', async () => {
  const grants = { operations: [], queries: [] };
  const current = generateWorkflowSdk(view, grants);
  const previous = generateWorkflowSdk(
    view,
    grants,
    LEGACY_WORKFLOW_SDK_VERSION,
  );
  const body =
    "if (event.receiptId === event.eventId) sdk.waitForEvent('goodsReceiptPosted', 1);";
  assert.doesNotMatch(current.declarations, /waitForEvent/);
  assert.doesNotThrow(() =>
    compileWorkflowBody("const label = '// @ts-ignore';", current),
  );
  assert.throws(
    () => compileWorkflowBody('// @ts-ignore\n' + body, current),
    /compiler suppression/,
  );
  assert.match(current.declarations, /90 days/);
  assert.throws(() => compileWorkflowBody(body, current), /waitForEvent/);
  const wait = {
    kind: 'waitForEvent',
    eventType: 'goodsReceiptPosted',
    timeoutMs: 1,
  };
  assert.throws(() => current.admitCall(wait), /external-event waits/);
  const cap = 90 * 24 * 60 * 60 * 1000;
  assert.deepEqual(current.admitCall({ kind: 'sleep', milliseconds: cap }), {
    kind: 'sleep',
    milliseconds: cap,
  });
  assert.throws(
    () => current.admitCall({ kind: 'sleep', milliseconds: cap + 1 }),
    /90 days/,
  );
  assert.deepEqual(
    previous.admitCall({ kind: 'sleep', milliseconds: cap + 1 }),
    { kind: 'sleep', milliseconds: cap + 1 },
  );
  assert.deepEqual(previous.admitCall(wait), wait);
  const result = await verifyRetainedWorkflow(
    view,
    { workflowId: 'old-wait', grants },
    {
      body,
      authoredBy: event.eventId,
      fixtures: [{ event, effects: [] }],
      executable: compileWorkflowBody(body, previous).executable,
    },
  );
  assert.deepEqual(result, {
    code: 'REMOVED_ACTION',
    subject: 'old-wait',
    expected: 'waitForEvent',
    observed: null,
  });
});

test('a CPU overrun retries once; a watchdog kill has its own evidence', async () => {
  const controls: string[] = [];
  let count = 0;
  assert.equal(
    await retryWorkflowStep(
      async () => {
        if (++count === 1) throw new WorkflowCpuLimit();
        return 'done';
      },
      (s) => controls.push(s),
    ),
    'done',
  );
  assert.deepEqual(controls, ['attempt-1-cpu-limit', 'attempt-2-completed']);
  controls.length = 0;
  await assert.rejects(
    retryWorkflowStep(
      async () => {
        throw new WorkflowWatchdogExpired();
      },
      (s) => controls.push(s),
    ),
    /watchdog/,
  );
  assert.deepEqual(controls, [
    'attempt-1-host-watchdog',
    'attempt-2-host-watchdog',
  ]);
});

test('a workflow review gesture binds the observed release fence, draft and rendered bytes', async () => {
  const { workflowReviewDecision } =
    await import('../../packages/postgres-provider/src/workflow-review.js');
  const pointer = { releaseId: 'release', pointerId: 'pointer', fence: 1 };
  const shown = workflowReviewDecision('draft', 'digest', pointer);
  assert.notEqual(
    shown,
    workflowReviewDecision('draft', 'digest', { ...pointer, fence: 3 }),
  );
  assert.notEqual(shown, workflowReviewDecision('other', 'digest', pointer));
  assert.notEqual(shown, workflowReviewDecision('draft', 'other', pointer));
});

test('the parent refuses a passed verification response missing the requested journal', async () => {
  const { fork } = await import('node:child_process');
  await assert.rejects(
    verifyWorkflowBundle(
      view,
      { operations: [], queries: [] },
      {
        body: 'sdk.now();',
        fixtures: [
          { event, effects: [{ call: { kind: 'now' }, result: day }] },
        ],
      },
      {
        launch: (_path, _argv, env) =>
          fork('unused', [], {
            env,
            execArgv: [
              '-e',
              `process.on('message',({protocol}) => process.send({protocol,response:JSON.stringify({status:'passed',executable:'function run(){}',journals:[],coverage:[],sites:[]})}));`,
            ],
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          }),
      },
    ),
    /mismatched fixture journal/,
  );
});

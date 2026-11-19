import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';

import { OPERATIONS_AGENT_TOOL_IDS } from '../../packages/compiler/src/index.js';
import { task3AnswerFailures } from './answer-rules.js';
import { OPERATION_CATALOG_PAYLOAD_VERSION } from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  businessDayAt,
  keyFromFile,
  OperationsAgentSession,
  loadModelKey,
  OPERATIONS_AGENT_TOOLS,
  runOperationsAgent,
  SpendMeter,
  type ModelAdapter,
} from '../../packages/operations-agent/src/index.js';

import {
  assistantRoute,
  DEFAULT_ANTHROPIC_MODEL,
  SONNET_MODEL,
} from '../../packages/operations-agent/src/anthropic-model.js';

test('the measured create route is independent of the module and honours overrides', () => {
  assert.deepEqual(assistantRoute('Create a delivery slip named Ridge.'), {
    modelId: SONNET_MODEL,
    effort: 'low',
  });
  for (const text of ['What is its name?', 'Create a slip then post it.'])
    assert.deepEqual(assistantRoute(text), {
      modelId: DEFAULT_ANTHROPIC_MODEL,
      effort: 'high',
    });
  assert.deepEqual(assistantRoute('Create a slip.', 'chosen'), {
    modelId: 'chosen',
    effort: 'high',
  });
});

const PLANTED = 'sk-planted-test-value-0123456789';

test('the model sees exactly the compiled five tools, in order', () => {
  assert.deepEqual(
    OPERATIONS_AGENT_TOOLS.map((tool) => tool.name),
    [...OPERATIONS_AGENT_TOOL_IDS],
  );
  for (const tool of OPERATIONS_AGENT_TOOLS) {
    const schema = JSON.stringify(tool.inputSchema);
    for (const owned of [
      'tenant',
      'principal',
      'permission',
      'handler',
      'table',
      'legalEntityId',
    ])
      assert.doesNotMatch(
        schema,
        new RegExp(`"${owned}`, 'u'),
        `${tool.name} exposes ${owned}`,
      );
  }
});

test('a key comes from the environment first, then exactly one name in the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-keys-'));
  const file = join(directory, '.env');
  await writeFile(
    file,
    `OTHER_SECRET=nope\r\nCLUADE_API_KEY=${PLANTED}\r\nOPENAI_API_KEY="${PLANTED}-o"\r\n`,
  );
  assert.equal(keyFromFile(`A=1\r\nB=2\r\n`, 'B'), '2');
  const fromFile = await loadModelKey('anthropic', {
    NORTH_STAR_AGENT_KEY_FILE: file,
  });
  assert.equal(fromFile.reveal(), PLANTED);
  assert.equal(
    (
      await loadModelKey('openai', { NORTH_STAR_AGENT_KEY_FILE: file })
    ).reveal(),
    `${PLANTED}-o`,
  );
  const fromEnvironment = await loadModelKey('anthropic', {
    ANTHROPIC_API_KEY: 'from-environment',
    NORTH_STAR_AGENT_KEY_FILE: file,
  });
  assert.equal(fromEnvironment.reveal(), 'from-environment');
  // Printing a key, by any route, shows nothing of it.
  for (const shown of [
    String(fromFile),
    JSON.stringify({ fromFile }),
    inspect(fromFile),
    `${fromFile}`,
  ])
    assert.doesNotMatch(shown, /planted/u);
});

test('a missing key names the variable and echoes no line of the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-keys-'));
  const file = join(directory, '.env');
  await writeFile(file, `OPENAI_API_KEY=${PLANTED}\r\nCLUADE_API_KEY=\r\n`);
  await assert.rejects(
    loadModelKey('anthropic', { NORTH_STAR_AGENT_KEY_FILE: file }),
    (error: Error) => {
      assert.match(error.message, /CLUADE_API_KEY/u);
      assert.doesNotMatch(error.message, /planted/u);
      return true;
    },
  );
  await assert.rejects(
    loadModelKey('anthropic', {}),
    /NORTH_STAR_AGENT_KEY_FILE/u,
  );
  await assert.rejects(
    loadModelKey('anthropic', {
      NORTH_STAR_AGENT_KEY_FILE: join(directory, 'absent'),
    }),
    (error: Error) => !error.message.includes(directory),
  );
});

test('the run stops at the spend cap before the next model call', async () => {
  let calls = 0;
  const model: ModelAdapter = {
    modelId: 'priced-fake',
    next: () => {
      calls += 1;
      return Promise.resolve({
        text: '',
        toolCalls: [
          {
            id: `c${String(calls)}`,
            name: 'erp_discover',
            input: { mode: 'context' },
          },
        ],
        stop: 'tools',
        usage: {
          inputTokens: 100_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    },
  };
  const session = {
    call: () => Promise.resolve({ content: {}, isError: false }),
  } as unknown as OperationsAgentSession;
  // Each call costs 0.1 * 4 + 0.01 * 20 = 0.6 USD; the cap is 1 USD.
  const meter = new SpendMeter(
    { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    1,
  );
  const result = await runOperationsAgent({
    model,
    session,
    request: 'loop',
    meter,
  });
  assert.equal(result.stop, 'spend-cap');
  assert.equal(calls, 2);
  assert.ok(Math.abs(result.usd - 1.2) < 1e-9);
});

test('a provider error that echoes the key never carries it outward', async () => {
  const { createServer } = await import('node:http');
  const { anthropicModel, ModelKey } =
    await import('../../packages/operations-agent/src/index.js');
  const server = createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `invalid x-api-key ${String(request.headers['x-api-key'])}`,
        },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address() as { port: number };
    const model = anthropicModel({
      key: new ModelKey(PLANTED),
      baseURL: `http://127.0.0.1:${String(address.port)}`,
    });
    await assert.rejects(
      model.next({
        system: 's',
        tools: OPERATIONS_AGENT_TOOLS,
        conversation: [{ role: 'user', text: 'hi' }],
      }),
      (error: Error) => {
        assert.match(error.name, /AnthropicAPIError\(401\)/u);
        assert.doesNotMatch(
          `${error.name} ${error.message} ${String(error.stack)}`,
          /planted/u,
        );
        return true;
      },
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

const EDMONTON = {
  timeZone: 'America/Edmonton',
  businessDayBoundary: '00:00:00',
};

test('the business date is the day in the tenant time zone, not UTC', () => {
  // 05:30Z is 22:30 the evening before in Edmonton (UTC-7 in November).
  assert.equal(
    businessDayAt(new Date('2026-11-17T05:30:00Z'), EDMONTON).date,
    '2026-11-16',
  );
  assert.equal(
    businessDayAt(new Date('2026-11-17T07:00:00Z'), EDMONTON).asDateTime,
    '2026-11-17T00:00:00.000Z',
  );
  // A 06:00 boundary: 03:00 local still belongs to the previous business day.
  assert.equal(
    businessDayAt(new Date('2026-11-17T10:00:00Z'), {
      ...EDMONTON,
      businessDayBoundary: '06:00:00',
    }).date,
    '2026-11-16',
  );
  // Daylight saving: July is UTC-6, so 05:30Z is still the evening before.
  assert.equal(
    businessDayAt(new Date('2026-07-01T05:30:00Z'), EDMONTON).date,
    '2026-06-30',
  );
  assert.equal(
    businessDayAt(new Date('2026-07-01T06:30:00Z'), EDMONTON).date,
    '2026-07-01',
  );
});

/** A session over a hand-made pinned view: no database, no operations. */
function contextSession(surfaces: unknown[]) {
  const view = {
    principalId: 'p',
    entryPolicyVersion: '1',
    release: { releaseId: 'r' },
    projections: {
      agent: { payload: { operations: [], queries: [], toolIds: [] } },
      operation: {
        payload: {
          kind: 'operationCatalogPayload',
          schemaVersion: OPERATION_CATALOG_PAYLOAD_VERSION,
          operations: [],
        },
      },
      query: { payload: { queries: [] } },
      surface: { payload: { surfaces } },
    },
  };
  return new OperationsAgentSession({
    runtime: {
      entry: {
        run: (_request: unknown, work: (v: unknown) => unknown) => work(view),
      },
    } as never,
    personHeaders: {},
    companyId: 'c',
    businessCalendar: EDMONTON,
    clock: () => new Date('2026-11-17T05:30:00Z'),
    approve: () => Promise.resolve(false),
  });
}

test('context carries the business date and the declared default currency', async () => {
  const declared = await contextSession([
    {
      documentEditor: {
        headerFields: [
          {
            inputId: 'northstar.app:input.invoice_method',
            presentation: {
              kind: 'choice',
              defaultValue: 'northstar.app:option.customer_payment_method_eft',
              options: [],
            },
          },
          {
            fieldId: 'northstar.app:field.purchase_order_currency',
            presentation: {
              kind: 'choice',
              defaultValue: 'CAD',
              options: [
                { value: 'CAD', label: 'CAD' },
                { value: 'USD', label: 'USD' },
              ],
            },
          },
        ],
      },
    },
  ]).call('erp_discover', { mode: 'context' });
  const context = declared.content as {
    today: { date: string; asDateTime: string; now: string; timeZone: string };
    currency: { default: string | null; offered: string[] };
  };
  assert.equal(context.today.date, '2026-11-16');
  assert.equal(context.today.asDateTime, '2026-11-16T00:00:00.000Z');
  assert.equal(context.today.timeZone, 'America/Edmonton');
  assert.equal(context.today.now, '2026-11-17T05:30:00.000Z');
  assert.equal(context.currency.default, 'CAD');
  assert.equal(
    (context as unknown as { formDefaults: { values: Record<string, string> } })
      .formDefaults.values.invoice_method,
    'northstar.app:option.customer_payment_method_eft',
  );
  assert.deepEqual(context.currency.offered, ['CAD', 'USD']);
});

test('a release that declares no currency gives the agent none to use', async () => {
  const absent = await contextSession([]).call('erp_discover', {
    mode: 'context',
  });
  const context = absent.content as { currency: { default: string | null } };
  assert.equal(context.currency.default, null);
  assert.match(JSON.stringify(absent.content), /do not invent one/u);
  assert.doesNotMatch(JSON.stringify(context.currency), /CAD|USD|EUR/u);
});

test('task 3 rule v2: a paid invoice may be named as paid, never as unpaid', () => {
  const context = {
    paid: 'INV-000001',
    unpaid: ['INV-000002', 'INV-000003'],
    balance: 52.5,
  };
  const good = [
    'Unpaid: INV-000002 and INV-000003. Total balance 52.50. INV-000001 is fully paid.',
    '- INV-000002\n- INV-000003\n- INV-000001: paid in full, not included\nTotal 52.5',
  ];
  for (const answer of good)
    assert.deepEqual(task3AnswerFailures(answer, context), [], answer);
  assert.ok(
    task3AnswerFailures(
      'Unpaid: INV-000001, INV-000002, INV-000003. Total 52.50.',
      context,
    ).length > 0,
  );
  assert.ok(
    task3AnswerFailures('INV-000002 and INV-000003 are unpaid.', context).some(
      (failure) => /52.5/u.test(failure),
    ),
  );
});

test('switching model prices retains the spend, including subsequent expensive turns', () => {
  const original = new SpendMeter(
    { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    1,
  );
  const fast = original.atPrices({
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  });
  fast.charge({
    inputTokens: 200_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(original.usd, 0.4);
  assert.equal(original.outputBudget(130_000), 0);
  original.charge({
    inputTokens: 150_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(fast.exhausted(), true);
});

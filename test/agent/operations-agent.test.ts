import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';

import { OPERATIONS_AGENT_TOOL_IDS } from '../../packages/compiler/src/index.js';
import {
  keyFromFile,
  loadModelKey,
  OPERATIONS_AGENT_TOOLS,
  runOperationsAgent,
  SpendMeter,
  type ModelAdapter,
  type OperationsAgentSession,
} from '../../packages/operations-agent/src/index.js';

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

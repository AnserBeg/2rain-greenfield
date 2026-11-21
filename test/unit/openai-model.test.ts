/**
 * AI-BUILD-1 slice 3: the OpenAI drafting adapter against a local stand-in.
 * The tools go out as functions, a tool call comes back as a turn with its
 * usage (cached input split out), and a provider error never carries the key.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { ModelKey } from '../../packages/operations-agent/src/keys.js';
import { openAiModel } from '../../packages/operations-agent/src/openai-model.js';

// Not shaped like a provider key, so the repository secret scan stays clean.
const KEY = 'local-stand-in-credential-0123456789';

async function standIn(
  reply: (body: Record<string, unknown>) => { status: number; body: unknown },
) {
  const seen: { auth: string | undefined; body: Record<string, unknown> }[] =
    [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString()));
    request.on('end', () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      seen.push({ auth: request.headers.authorization, body });
      const answer = reply(body);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

test('the OpenAI adapter sends tools as functions and reads a tool call', async () => {
  const server = await standIn(() => ({
    status: 200,
    body: {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'draft_customization',
                  arguments: '{"kind":"addField"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    },
  }));
  try {
    const model = openAiModel({
      key: new ModelKey(KEY),
      modelId: 'gpt-test',
      effort: 'medium',
      baseURL: server.baseURL,
    });
    const turn = await model.next({
      system: 'system text',
      tools: [
        {
          name: 'draft_customization' as never,
          description: 'Draft one change.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      conversation: [{ role: 'user', text: 'Add a field' }],
    });
    assert.deepEqual(turn.toolCalls, [
      {
        id: 'call_1',
        name: 'draft_customization',
        input: { kind: 'addField' },
      },
    ]);
    assert.equal(turn.stop, 'tools');
    assert.deepEqual(turn.usage, {
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    const sent = server.seen[0]!;
    assert.equal(sent.auth, `Bearer ${KEY}`);
    assert.equal(sent.body.reasoning_effort, 'medium');
    assert.deepEqual(
      (sent.body.messages as { role: string }[]).map((m) => m.role),
      ['system', 'user'],
    );
    assert.equal(
      (sent.body.tools as { function: { name: string } }[])[0]!.function.name,
      'draft_customization',
    );
  } finally {
    await server.close();
  }
});

test('an OpenAI error never carries the key', async () => {
  const server = await standIn(() => ({
    status: 400,
    body: { error: { message: `bad request for key ${KEY}` } },
  }));
  try {
    const model = openAiModel({
      key: new ModelKey(KEY),
      modelId: 'gpt-test',
      baseURL: server.baseURL,
    });
    await assert.rejects(
      model.next({
        system: 's',
        tools: [],
        conversation: [{ role: 'user', text: 'x' }],
      }),
      (error: Error) => {
        assert.equal(error.name, 'OpenAiAPIError');
        assert.ok(!error.message.includes(KEY));
        assert.match(error.message, /\[model key\]/u);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

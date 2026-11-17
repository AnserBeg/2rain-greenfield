import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import {
  ASSISTANT_PANEL_CSP_HASH,
  ASSISTANT_PANEL_SCRIPT,
  withAssistantPanel,
} from '../../apps/web/src/assistant-panel.js';
import {
  createAssistantEndpoint,
  type CustomizeDrafter,
} from '../../apps/api/src/assistant-endpoint.js';
import {
  scriptedModel,
  type ModelAdapter,
  type ScriptStep,
} from '../../packages/operations-agent/src/index.js';
import { createHash } from 'node:crypto';

import { compiledAppView } from './compiled-view.js';

const NS = 'northstar.app';
const RECORD = '0d9c6f2e-3a1b-4c5d-8e7f-001122334455';

/**
 * A runtime over the compiled release with stub gateways: the person is the
 * cookie's demo actor, every id is eligible, and a get returns one party.
 */
function fakeRuntime(log: string[]) {
  return {
    entry: {
      run: (
        request: { headers: Record<string, unknown> },
        work: (view: unknown) => unknown,
      ) => {
        const actor = /northstar-demo-actor=(\w+)/u.exec(
          String(request.headers.cookie ?? ''),
        )?.[1];
        if (!actor) return Promise.reject(new Error('no identity'));
        return Promise.resolve(work(compiledAppView(actor)));
      },
    },
    operationGateway: {
      previewTaskEligibility: () => Promise.resolve('eligible'),
      invoke: () => Promise.reject(new Error('no writes in this test')),
    },
    operationMediation: {},
    queryGateway: {
      previewEligibility: () => Promise.resolve('eligible'),
      invoke: (_view: unknown, request: { queryId: string }) => {
        log.push(request.queryId);
        return Promise.resolve({
          outcome: 'exact',
          records: [
            {
              recordId: RECORD,
              revision: 1,
              archived: false,
              values: {
                [`${NS}:field.party_number`]: 'P-2016',
                [`${NS}:field.party_name`]: 'Lethbridge Millwork',
              },
            },
          ],
        });
      },
    },
  };
}

async function serve(
  model: ModelAdapter,
  log: string[],
  capUsd?: number,
  customize?: CustomizeDrafter,
): Promise<{ url: string; server: Server }> {
  const endpoint = createAssistantEndpoint({
    runtime: fakeRuntime(log) as never,
    companyId: 'company',
    model: () => Promise.resolve(model),
    ...(capUsd !== undefined ? { capUsd } : {}),
    ...(customize ? { customize: () => Promise.resolve(customize) } : {}),
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');
    void endpoint.handle(request, response, url).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${String(address.port)}`, server };
}

const headers = (actor: string, url: string) => ({
  'content-type': 'application/json',
  'x-northstar-assistant': '1',
  origin: url,
  cookie: `northstar-demo-actor=${actor}`,
});

async function events(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a turn streams steps and an answer, reads the screen record fresh, and links what it read', async () => {
  const log: string[] = [];
  let seen = '';
  const steps: ScriptStep[] = [
    (conversation) => {
      seen = conversation[0]?.role === 'user' ? conversation[0].text : '';
      return {
        toolCalls: [
          {
            name: 'erp_query',
            input: { queryId: 'party_get', arguments: { recordId: RECORD } },
          },
        ],
      };
    },
    () => ({ text: 'Lethbridge Millwork is customer P-2016.' }),
  ];
  const { url, server } = await serve(scriptedModel(steps), log);
  try {
    const response = await fetch(`${url}/?assistant=ask`, {
      method: 'POST',
      headers: headers('buyer', url),
      body: JSON.stringify({
        text: 'Who is this?',
        screen: { surfaceId: `${NS}:surface.party_detail`, recordId: RECORD },
      }),
    });
    const stream = await events(response);
    const types = stream.map((event) => event.type);
    assert.equal(types[0], 'conversation');
    assert.ok(types.includes('step'));
    const answer = stream.find((event) => event.type === 'answer')!;
    assert.equal(answer.text, 'Lethbridge Millwork is customer P-2016.');
    assert.deepEqual(answer.links, [
      {
        href: `/?surface=${encodeURIComponent(`${NS}:surface.party_detail`)}&record=${RECORD}`,
        label: 'P-2016',
        wrote: false,
      },
    ]);
    // The page's record was read by the host as the person, not taken from
    // the browser, and its values reached the model with the request.
    // (the party page reads through its own get query, party_credit_get)
    assert.equal(log[0], `${NS}:query.party_credit_get`);
    assert.match(seen, /Screen: the person is on "Party detail"/u);
    assert.match(seen, /read just now through party_credit_get/u);
    assert.match(seen, /Lethbridge Millwork/u);
    assert.ok(
      stream.some(
        (event) => event.type === 'step' && event.label === 'Reading party get',
      ),
    );
  } finally {
    server.close();
  }
});

test("a conversation is its starter's; a cross-site or unmarked request is refused", async () => {
  const { url, server } = await serve(
    scriptedModel([() => ({ text: 'one' }), () => ({ text: 'two' })]),
    [],
  );
  try {
    const first = await events(
      await fetch(`${url}/?assistant=ask`, {
        method: 'POST',
        headers: headers('buyer', url),
        body: JSON.stringify({ text: 'hello' }),
      }),
    );
    const id = first[0]!.id as string;
    // The manager naming the buyer's conversation gets a new one.
    const other = await events(
      await fetch(`${url}/?assistant=ask`, {
        method: 'POST',
        headers: headers('manager', url),
        body: JSON.stringify({ text: 'hello', conversation: id }),
      }),
    );
    assert.notEqual(other[0]!.id, id);
    const crossSite = await fetch(`${url}/?assistant=ask`, {
      method: 'POST',
      headers: { ...headers('buyer', url), origin: 'http://evil.example' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(crossSite.status, 403);
    const unmarked = await fetch(`${url}/?assistant=ask`, {
      method: 'POST',
      headers: { ...headers('buyer', url), 'x-northstar-assistant': '0' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(unmarked.status, 403);
  } finally {
    server.close();
  }
});

test('a plan waits for a yes bound to exactly that plan; a wrong digest decides nothing', async () => {
  let planResult: Record<string, unknown> = {};
  const model = scriptedModel([
    // The record is looked up first: a plan may name only ids the host
    // returned in this conversation (slice 4).
    () => ({
      toolCalls: [
        {
          name: 'erp_query',
          input: { queryId: 'party_get', arguments: { recordId: RECORD } },
        },
      ],
    }),
    () => ({
      toolCalls: [
        {
          name: 'erp_plan',
          input: {
            intents: [
              // Archiving needs the person's yes (slice 3's risk class).
              { operationId: 'party_archive', target: RECORD },
            ],
          },
        },
      ],
    }),
    (conversation) => {
      const last = conversation.at(-1);
      planResult =
        last?.role === 'tool'
          ? (JSON.parse(last.results[0]!.content) as Record<string, unknown>)
          : {};
      return { text: 'done' };
    },
  ]);
  const { url, server } = await serve(model, []);
  try {
    const response = await fetch(`${url}/?assistant=ask`, {
      method: 'POST',
      headers: headers('buyer', url),
      body: JSON.stringify({ text: 'archive this customer' }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let plan: Record<string, unknown> | undefined;
    let conversation = '';
    while (!plan) {
      const { value, done } = await reader.read();
      assert.ok(!done, 'the stream ended before a plan was shown');
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n').slice(0, -1)) {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'conversation') conversation = event.id as string;
        if (event.type === 'plan') plan = event;
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    }
    const decide = (body: Record<string, unknown>, actor = 'buyer') =>
      fetch(`${url}/?assistant=decide`, {
        method: 'POST',
        headers: headers(actor, url),
        body: JSON.stringify({ conversation, ...body }),
      });
    assert.equal(
      (await decide({ planId: plan.planId, digest: 'x', approve: true }))
        .status,
      409,
    );
    assert.equal(
      (
        await decide(
          { planId: plan.planId, digest: plan.digest, approve: true },
          'manager',
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await decide({
          planId: plan.planId,
          digest: plan.digest,
          approve: true,
        })
      ).status,
      204,
    );
    while (!(await reader.read()).done);
    assert.equal(planResult.approval, 'approved by the person');
  } finally {
    server.close();
  }
});

test('a conversation past its spend cap answers plainly and calls no model', async () => {
  let calls = 0;
  const model: ModelAdapter = {
    modelId: 'priced',
    next: () => {
      calls += 1;
      return Promise.resolve({
        text: 'ok',
        toolCalls: [],
        stop: 'end',
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    },
  };
  const { url, server } = await serve(model, [], 1);
  try {
    const ask = async (conversation?: string) =>
      events(
        await fetch(`${url}/?assistant=ask`, {
          method: 'POST',
          headers: headers('buyer', url),
          body: JSON.stringify({ text: 'hi', conversation }),
        }),
      );
    const first = await ask();
    const second = await ask(first[0]!.id as string);
    const answer = second.find((event) => event.type === 'answer')!;
    assert.equal(answer.stop, 'spend-cap');
    assert.match(String(answer.text), /spending limit of USD 1\.00/u);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('the panel is added to a full page only, with its script pinned by hash', () => {
  assert.equal(
    ASSISTANT_PANEL_CSP_HASH,
    `sha256-${createHash('sha256').update(ASSISTANT_PANEL_SCRIPT).digest('base64')}`,
  );
  const page = withAssistantPanel({
    statusCode: 200,
    html: '<html><body><main>x</main></body></html>',
  });
  assert.match(page.html, /data-assistant-panel/u);
  assert.ok(page.html.includes(`<script>${ASSISTANT_PANEL_SCRIPT}</script>`));
  for (const result of [
    { statusCode: 303, html: '' },
    { statusCode: 200, html: '<tr>fragment</tr>' },
    { statusCode: 500, html: '<html><body></body></html>' },
  ])
    assert.equal(withAssistantPanel(result), result);
  // Model text never becomes markup: the script writes text nodes only.
  assert.doesNotMatch(ASSISTANT_PANEL_SCRIPT, /innerHTML|insertAdjacentHTML/u);
});

test('Stop ends the run before the next model call; the reply says what happened', async () => {
  let started!: () => void;
  const running = new Promise<void>((done) => (started = done));
  const model: ModelAdapter = {
    modelId: 'slow',
    next: ({ signal }) =>
      new Promise((_resolve, reject) => {
        started();
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };
  const { url, server } = await serve(model, []);
  try {
    const pending = fetch(`${url}/?assistant=ask`, {
      method: 'POST',
      headers: headers('buyer', url),
      body: JSON.stringify({ text: 'take your time' }),
    });
    const response = await pending;
    const reader = response.body!.getReader();
    const first = JSON.parse(
      new TextDecoder().decode((await reader.read()).value).split('\n')[0]!,
    ) as { id: string };
    await running;
    assert.equal(
      (
        await fetch(`${url}/?assistant=stop`, {
          method: 'POST',
          headers: headers('buyer', url),
          body: JSON.stringify({ conversation: first.id }),
        })
      ).status,
      204,
    );
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const answer = rest
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === 'answer')!;
    assert.equal(answer.stop, 'stopped');
    assert.match(String(answer.text), /^Stopped\./u);
  } finally {
    server.close();
  }
});

test('a request to change the application goes to the customization draft, shown as a diff, never approved', async () => {
  const asked: string[] = [];
  const drafter: CustomizeDrafter = {
    draftFromRequest: (request) => {
      asked.push(request);
      return Promise.resolve({
        status: 'drafted',
        reused: false,
        renderedDiff:
          'New field "Serial number" on Equipment\nNothing is live yet',
      });
    },
  };
  const { url, server } = await serve(
    scriptedModel([
      () => ({ text: 'HANDOFF customize: add a serial number to Equipment' }),
    ]),
    [],
    undefined,
    drafter,
  );
  try {
    const stream = await events(
      await fetch(`${url}/?assistant=ask`, {
        method: 'POST',
        headers: headers('buyer', url),
        body: JSON.stringify({ text: 'Add a serial number to Equipment' }),
      }),
    );
    const answer = stream.find((event) => event.type === 'answer')!;
    assert.equal(answer.stop, 'handoff');
    assert.deepEqual(answer.draft, {
      diff: 'New field "Serial number" on Equipment\nNothing is live yet',
    });
    assert.match(String(answer.text), /nothing is live yet/u);
    // The person's own words are drafted; the panel has no approve path.
    assert.deepEqual(asked, ['Add a serial number to Equipment']);
    assert.ok(!stream.some((event) => event.type === 'plan'));
  } finally {
    server.close();
  }
});

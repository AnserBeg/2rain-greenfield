/**
 * AI-RELY-1 task 0 (review finding R1): does the assistant's request pattern
 * get rejected (HTTP 400) or run on stale reasoning? MANUAL AND LIVE ONLY;
 * never in CI (no package script, no test glob names this file).
 *
 *   NORTH_STAR_AGENT_KEY_FILE=/path/.env node --import tsx \
 *     packages/operations-agent/probes/prefix-check-probe.ts --cap 1.00 --out /path/run.jsonl
 *
 * The key is read ONLY from the file named by NORTH_STAR_AGENT_KEY_FILE
 * (`CLUADE_API_KEY`), through the repo's own `loadModelKey` with an
 * environment holding nothing but that variable, so an ambient key never
 * wins. No key, message text or file line is printed or logged; error text is
 * scrubbed of the key.
 *
 * One conversation, built with the production request shape of
 * `anthropic-model.ts` (top-level and system and last-tool cache breakpoints,
 * explicit effort, assistant turns replayed as the provider's raw content via
 * the production `toMessages`), and the production history edits of
 * `loop.ts` / `assistant-endpoint.ts`:
 *   T1 Opus 5.5 high, system v1, a tool round trip (mint, honest replay)
 *   T2 Opus 5.5 high, system v2 (the business map rebuilt after a release)
 *   T3 Sonnet 5.5 low ("add a ..." routes there), system v2
 *   T4 Opus 5.5 high, system v2, the first exchange trimmed from the front
 * Each production-shape call (no beta header, no block_binding) is followed
 * by a cheap diagnostic copy (max_tokens 16) with the
 * `thinking-binding-controls-2026-08-01` header and no field, which only
 * reports `input_transformations`. Non-streaming: the transport does not
 * change the check. max_tokens is 2000 (outside the compared prefix).
 */
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';

import { loadModelKey } from '../src/keys.js';
import { toMessages } from '../src/anthropic-model.js';
import { withoutReasoning } from '../src/loop.js';
import type { ConversationEntry } from '../src/model.js';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
// USD per million tokens, the repo's tables (assistant-endpoint.ts,
// anthropic-model.ts), Anthropic first-party API.
const PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  [OPUS]: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  [SONNET]: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};
const BETA = 'thinking-binding-controls-2026-08-01';
const MAX_TOKENS = 2000;

const { values } = parseArgs({
  options: {
    cap: { type: 'string', default: '1.00' },
    out: { type: 'string' },
    scenario: { type: 'string', default: 'mixed' },
    // Apply loop.ts's fix (withoutReasoning on a rebuilt prompt or a cut).
    fixed: { type: 'boolean', default: false },
  },
});
const cap = Number(values.cap);
const out = values.out;
if (!out || !(cap > 0)) throw new Error('--cap and --out are required');

const keyFile = process.env.NORTH_STAR_AGENT_KEY_FILE;
const key = await loadModelKey('anthropic', {
  NORTH_STAR_AGENT_KEY_FILE: keyFile,
});
const client = new Anthropic({ apiKey: key.reveal(), maxRetries: 0 });
const scrub = (text: string) => text.split(key.reveal()).join('[model key]');

const cacheControl = { type: 'ephemeral' as const };
const TOOLS = [
  {
    name: 'record_lookup',
    description:
      'Read one ERP record by its number. Returns the record fields as JSON.',
    input_schema: {
      type: 'object' as const,
      properties: { record: { type: 'string' } },
      required: ['record'],
    },
  },
];
const base =
  'You operate an ERP for an office worker. Look records up with record_lookup before you answer; never guess a value. Answer in one short sentence.';
const SYSTEM_V1 = `${base}\nBusiness map (release r1): customer records have fields name, credit_limit, currency.`;
const SYSTEM_V2 = `${base}\nBusiness map (release r2): customer records have fields name, credit_limit, currency, payment_terms.`;
const RECORD = JSON.stringify({
  record: 'C-100',
  name: 'Harbor Supply',
  credit_limit: 5000,
  currency: 'USD',
  payment_terms: 'Net 30',
});

let spent = 0;
let calls = 0;

function request(
  model: string,
  system: string,
  conversation: readonly ConversationEntry[],
  maxTokens: number,
) {
  return {
    model,
    max_tokens: maxTokens,
    cache_control: cacheControl,
    output_config: { effort: model === SONNET ? 'low' : 'high' },
    system: [
      { type: 'text' as const, text: system, cache_control: cacheControl },
    ],
    tools: TOOLS.map((tool, index) =>
      index === TOOLS.length - 1
        ? { ...tool, cache_control: cacheControl }
        : tool,
    ),
    messages: toMessages(conversation),
  };
}

function thinkingPaths(messages: readonly Anthropic.MessageParam[]): string[] {
  const paths: string[] = [];
  messages.forEach((message, i) => {
    if (typeof message.content === 'string') return;
    message.content.forEach((block, j) => {
      if (block.type === 'thinking' || block.type === 'redacted_thinking')
        paths.push(`messages.${i}.content.${j}`);
    });
  });
  return paths;
}

async function estimate(
  body: ReturnType<typeof request>,
): Promise<{ inputTokens: number; source: string }> {
  try {
    const counted = await client.beta.messages.countTokens(
      {
        model: body.model,
        system: body.system,
        tools: body.tools,
        messages: body.messages as Anthropic.Beta.BetaMessageParam[],
        thinking: { type: 'adaptive' },
      },
      { headers: { 'anthropic-beta': BETA } },
    );
    return { inputTokens: counted.input_tokens, source: 'count_tokens' };
  } catch {
    // A conservative character estimate if counting is refused.
    return {
      inputTokens: Math.ceil(JSON.stringify(body).length / 2),
      source: 'chars/2',
    };
  }
}

type Outcome = {
  status: number;
  message?: Anthropic.Message;
  transformations?: unknown;
  diagnosisHeader?: string | null;
  error?: string;
};

async function call(
  label: string,
  body: ReturnType<typeof request>,
  diagnostic: boolean,
): Promise<Outcome> {
  const prices = PRICES[body.model]!;
  const { inputTokens, source } = await estimate(body);
  const worst =
    (inputTokens * prices.cacheWrite + body.max_tokens * prices.output) / 1e6;
  if (spent + worst > cap) {
    await log({ label, skipped: 'cap', spent, worst });
    throw new Error(`stopping before ${label}: worst case would pass the cap`);
  }
  calls += 1;
  let outcome: Outcome;
  try {
    const sent = diagnostic
      ? client.beta.messages.create({
          ...(body as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming),
          betas: [BETA],
        })
      : client.messages.create(
          body as unknown as Anthropic.MessageCreateParamsNonStreaming,
        );
    const { data, response } = await sent.withResponse();
    const raw = data as unknown as Record<string, unknown>;
    outcome = {
      status: response.status,
      message: data as unknown as Anthropic.Message,
      transformations:
        'input_transformations' in raw ? raw.input_transformations : '(absent)',
      diagnosisHeader: response.headers.get(
        'anthropic-thinking-prefix-mismatch',
      ),
    };
  } catch (error) {
    if (!(error instanceof Anthropic.APIError)) throw error;
    outcome = {
      status: error.status ?? 0,
      error: scrub(error.message),
      diagnosisHeader:
        error.headers?.get?.('anthropic-thinking-prefix-mismatch') ?? null,
    };
  }
  const usage = outcome.message?.usage;
  const usd = usage
    ? (usage.input_tokens * prices.input +
        (usage.cache_read_input_tokens ?? 0) * prices.cacheRead +
        (usage.cache_creation_input_tokens ?? 0) * prices.cacheWrite +
        usage.output_tokens * prices.output) /
      1e6
    : 0;
  spent += usd;
  const content = outcome.message?.content ?? [];
  await log({
    label,
    model: body.model,
    effort: body.output_config.effort,
    systemVersion: body.system[0]!.text === SYSTEM_V1 ? 'v1' : 'v2',
    diagnostic,
    beta: diagnostic ? BETA : null,
    estimate: { inputTokens, source, worstUsd: round(worst) },
    replayedThinking: thinkingPaths(body.messages),
    status: outcome.status,
    requestId: outcome.message?.id ?? null,
    stopReason: outcome.message?.stop_reason ?? null,
    usage: usage
      ? {
          input: usage.input_tokens,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          output: usage.output_tokens,
        }
      : null,
    usd: round(usd),
    spentUsd: round(spent),
    minted: content
      .filter((block) => block.type === 'thinking')
      .map((block) => ({ signed: !!block.signature })),
    toolCalls: content.filter((block) => block.type === 'tool_use').length,
    inputTransformations: outcome.transformations ?? null,
    diagnosisHeader: outcome.diagnosisHeader ?? null,
    error: outcome.error ?? null,
  });
  return outcome;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
async function log(entry: Record<string, unknown>) {
  const line = scrub(JSON.stringify(entry));
  console.log(line);
  await appendFile(out!, line + '\n');
}

function assistant(message: Anthropic.Message): ConversationEntry {
  return {
    role: 'assistant',
    text: '',
    toolCalls: message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input })),
    providerContent: message.content,
  };
}

/** The same body with the behaviour set explicitly (needs the header). */
function bound(
  body: ReturnType<typeof request>,
  behavior: 'error' | 'drop_block',
): ReturnType<typeof request> {
  return {
    ...body,
    thinking: {
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: behavior },
    },
  } as unknown as ReturnType<typeof request>;
}
let probeError = false;

/**
 * One panel turn: the production call, its diagnostic copy, and tool round
 * trips until the model ends. A production 400 is recorded and the turn is
 * continued under drop_block so later causes can still be measured (and the
 * record says the production conversation would have died there).
 */
async function turn(
  name: string,
  model: string,
  system: string,
  conversation: ConversationEntry[],
): Promise<void> {
  for (let step = 1; step <= 3; step += 1) {
    const label = `${name}.${step}`;
    const body = request(model, system, conversation, MAX_TOKENS);
    let outcome = await call(`${label} production`, body, false);
    if (thinkingPaths(body.messages).length > 0)
      await call(
        `${label} diagnostic`,
        request(model, system, conversation, 16),
        true,
      );
    if (!outcome.message) {
      outcome = await call(
        `${label} continue(drop_block)`,
        bound(body, 'drop_block'),
        true,
      );
      if (!outcome.message) throw new Error(`${label}: could not continue`);
    }
    if (probeError && thinkingPaths(body.messages).length > 0)
      await call(
        `${label} diagnostic(error)`,
        bound(request(model, system, conversation, 16), 'error'),
        true,
      );
    const reply = assistant(outcome.message);
    conversation.push(reply);
    if (reply.role !== 'assistant' || reply.toolCalls.length === 0) return;
    conversation.push({
      role: 'tool',
      results: reply.toolCalls.map((c) => ({
        id: c.id,
        content: RECORD,
        isError: false,
      })),
    });
  }
}

const conversation: ConversationEntry[] = [];
const rebuilt = () => {
  if (values.fixed)
    conversation.splice(
      0,
      conversation.length,
      ...withoutReasoning(conversation),
    );
};
try {
  if (values.scenario === 'system') {
    // Cause (1) alone: a block minted under system v1, then the system
    // prompt rebuilt (a release change), same model throughout.
    conversation.push({
      role: 'user',
      text: 'Customer C-100 has open invoices of 1234.56, 2345.67 and 987.65 in its currency. Look the customer up, then tell me how much of its credit limit is still free, as an amount and as a percentage to one decimal.',
    });
    await turn('S1', OPUS, SYSTEM_V1, conversation);
    conversation.push({
      role: 'user',
      text: 'And if a fourth invoice of 400 arrives, what percentage is free then?',
    });
    await turn('S2', OPUS, SYSTEM_V1, conversation);
    probeError = true;
    rebuilt();
    conversation.push({
      role: 'user',
      text: 'Which payment terms does C-100 have?',
    });
    await turn('S3', OPUS, SYSTEM_V2, conversation);
  } else {
    conversation.push({
      role: 'user',
      text: 'What is the credit limit of customer C-100?',
    });
    await turn('T1', OPUS, SYSTEM_V1, conversation);
    conversation.push({
      role: 'user',
      text: 'Does C-100 have payment terms? If so, which, and how many days is that?',
    });
    rebuilt();
    await turn('T2', OPUS, SYSTEM_V2, conversation);
    conversation.push({
      role: 'user',
      text: 'Add a short note to customer C-100 summarising its credit limit and terms.',
    });
    await turn('T3', SONNET, SYSTEM_V2, conversation);
    // loop.ts:286-302: remove the first complete exchange, keep later ones.
    const next = conversation.findIndex((e, i) => i > 0 && e.role === 'user');
    conversation.splice(0, next);
    rebuilt();
    conversation.push({
      role: 'user',
      text: "Remind me: what is C-100's credit limit in its own currency?",
    });
    await turn('T4', OPUS, SYSTEM_V2, conversation);
  }
} finally {
  await log({
    label: 'total',
    fixed: values.fixed,
    calls,
    spentUsd: round(spent),
    capUsd: cap,
  });
}

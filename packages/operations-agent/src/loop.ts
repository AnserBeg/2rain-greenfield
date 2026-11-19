/**
 * The agent loop: the model proposes tool calls, the session runs them, and
 * the loop stops on a final answer, a turn limit or the spend cap. The cap is
 * checked before every model call, so a run never starts a call once its
 * spend has reached the cap.
 */
import type {
  ConversationEntry,
  ModelAdapter,
  ModelTurn,
  ModelUsage,
  ToolCall,
} from './model.js';
import { toMessages } from './anthropic-model.js';
import { isRecord } from './catalog.js';
import type { AgentScreen, OperationsAgentSession } from './session.js';
import {
  OPERATIONS_AGENT_SYSTEM_PROMPT,
  OPERATIONS_AGENT_TOOLS,
} from './tools.js';

/** USD per million tokens, read from the provider's price list at run time. */
export interface ModelPrices {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Accumulates spend across every run that shares it. */
export class SpendMeter {
  #spend = { usd: 0 };
  readonly #prices: ModelPrices | null;
  readonly capUsd: number;
  constructor(prices: ModelPrices | null, capUsd: number) {
    this.#prices = prices;
    this.capUsd = capUsd;
  }
  get usd(): number {
    return this.#spend.usd;
  }
  /** Use the selected model's tariff, sharing the conversation's actual spend and cap. */
  atPrices(prices: ModelPrices): SpendMeter {
    const modelMeter = new SpendMeter(prices, this.capUsd);
    modelMeter.#spend = this.#spend;
    return modelMeter;
  }
  charge(usage: ModelUsage): number {
    if (!this.#prices) return 0;
    const cost =
      (usage.inputTokens * this.#prices.input +
        usage.outputTokens * this.#prices.output +
        usage.cacheReadTokens * this.#prices.cacheRead +
        usage.cacheWriteTokens * this.#prices.cacheWrite) /
      1_000_000;
    this.#spend.usd += cost;
    return cost;
  }
  exhausted(): boolean {
    return this.#spend.usd >= this.capUsd;
  }
  /**
   * The output tokens one call may use (end review X13): what is left of the
   * cap after the call's estimated input, priced at the highest input rate, at the
   * output price. 0 when less than a minimal reply is left; undefined when
   * unpriced (no cap to keep).
   */
  outputBudget(estimatedInputTokens: number): number | undefined {
    if (!this.#prices) return undefined;
    const left =
      this.capUsd -
      this.#spend.usd -
      (estimatedInputTokens *
        Math.max(
          this.#prices.input,
          this.#prices.cacheWrite,
          this.#prices.cacheRead,
        )) /
        1_000_000;
    const tokens = Math.floor((left * 1_000_000) / this.#prices.output);
    return tokens < MINIMUM_CALL_OUTPUT_TOKENS
      ? 0
      : Math.min(tokens, CALL_OUTPUT_CEILING);
  }
}

/** The output a call is given when the cap leaves room (the adapter's own). */
export const CALL_OUTPUT_CEILING = 16_000;
/** Less than this left under the cap and no call starts. */
export const MINIMUM_CALL_OUTPUT_TOKENS = 1_024;

/** Thrown before a call the cap no longer leaves room for. */
export class SpendCapReached extends Error {
  override readonly name = 'SpendCapReached';
}

/** Reserve one token per serialized UTF-8 byte, including tool-data escaping,
 * plus room for provider message framing. */
export function estimateInputTokens(
  request: Pick<
    Parameters<ModelAdapter['next']>[0],
    'system' | 'tools' | 'conversation'
  >,
): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        system: [
          {
            type: 'text',
            text: request.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: request.tools,
        messages: toMessages(
          request.conversation as readonly ConversationEntry[],
        ),
      }),
      'utf8',
    ) + 256
  );
}

/**
 * One model call under a meter (end review X13): it starts only if the cap
 * leaves room for its estimated input and a minimal reply, its output is
 * bounded by what is left, and it is charged its usage; a call that was
 * stopped or failed after streaming is charged an estimate (its input and
 * the text it streamed), since the provider may bill it.
 */
export async function meteredNext(
  model: ModelAdapter,
  meter: SpendMeter,
  request: Parameters<ModelAdapter['next']>[0],
): Promise<{ turn: ModelTurn; usd: number; maxOutputTokens?: number }> {
  if (meter.exhausted()) throw new SpendCapReached('spend cap reached');
  const inputTokens = estimateInputTokens(request);
  const maxOutputTokens = meter.outputBudget(inputTokens);
  if (maxOutputTokens === 0) throw new SpendCapReached('spend cap reached');
  let streamed = 0;
  try {
    const turn = await model.next({
      ...request,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      onText: (delta) => {
        streamed += Buffer.byteLength(delta);
        request.onText?.(delta);
      },
    });
    return {
      turn,
      usd: meter.charge(turn.usage),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    };
  } catch (error) {
    if (request.signal?.aborted || streamed > 0)
      meter.charge({
        inputTokens: 0,
        outputTokens: Math.min(
          streamed,
          maxOutputTokens ?? CALL_OUTPUT_CEILING,
        ),
        cacheReadTokens: 0,
        cacheWriteTokens: inputTokens,
      });
    throw error;
  }
}

export interface AgentRunResult {
  readonly answer: string;
  readonly stop:
    | 'answered'
    | 'turn-limit'
    | 'spend-cap'
    | 'refusal'
    | 'model-error'
    | 'stopped';
  readonly turns: number;
  readonly toolCalls: number;
  readonly usage: ModelUsage;
  readonly usd: number;
  readonly conversation: readonly ConversationEntry[];
  /** Wall time of the run on a monotonic clock, in seconds. */
  readonly seconds: number;
  readonly error?: string;
  /**
   * A standalone erp_plan customization intent directed to the drafting lane.
   */
  readonly handoff?: { readonly change: string };
}

export interface AgentRunOptions {
  readonly model: ModelAdapter;
  readonly session: OperationsAgentSession;
  readonly request: string;
  readonly meter: SpendMeter;
  readonly maximumTurns?: number;
  /** Complete a person's approved card in the host before requesting a summary. */
  readonly executeAfterApproval?: boolean;
  readonly onEvent?: (event: AgentEvent) => void;
  /**
   * The session's preamble (`agentPreamble`): the business map, appended to
   * the system prompt and cached with it, and this turn's context, sent with
   * the request. Without it the model starts from the bare prompt.
   */
  readonly preamble?: AgentPreamble;
  /** Earlier turns of the same conversation, replayed unchanged. */
  readonly history?: readonly ConversationEntry[];
  /** The person's Stop: no model or tool call starts after it fires. */
  readonly signal?: AbortSignal;
}

export interface AgentPreamble {
  readonly businessMap: string;
  readonly turnContext: string;
}

/**
 * The business map and the turn's context for one acting person, read
 * through their session (so filtered by their eligibility now).
 */
export async function agentPreamble(
  session: OperationsAgentSession,
  screen?: AgentScreen | null,
): Promise<AgentPreamble> {
  const [businessMap, turnContext] = await Promise.all([
    session.businessMap(),
    session.turnContext(screen),
  ]);
  return { businessMap, turnContext };
}

/** The system prompt the model is given, with the map when there is one. */
export function systemPrompt(preamble?: AgentPreamble): string {
  return preamble?.businessMap
    ? `${OPERATIONS_AGENT_SYSTEM_PROMPT}\n\n# Business map (what you may read and do; ! = the person must confirm)\n${BUSINESS_MAP_LEGEND}\n${preamble.businessMap}`
    : OPERATIONS_AGENT_SYSTEM_PROMPT;
}

const BUSINESS_MAP_LEGEND =
  'Each "## name" is a record type with its states. "read:" lists queries as id[type] (by = what resolve matches on; views = preset list views by id). Each "- id: does" is an operation; values/patch list writable fields (* required, (a|b) options, :kind otherwise text). A field, option, relation or view is written here without its record type\'s prefix; use it as written or as its full id. "screen" lines are the steps a screen button runs, with where each input comes from.';

export type AgentEvent =
  | {
      readonly kind: 'model';
      readonly messages: number;
      readonly stop: string;
      readonly usage: ModelUsage;
      readonly usd: number;
    }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'tool'; readonly name: string; readonly input: unknown }
  | {
      readonly kind: 'result';
      readonly name: string;
      readonly isError: boolean;
      readonly content: unknown;
    };

export async function runOperationsAgent(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const conversation: ConversationEntry[] = [
    ...(options.history ?? []),
    {
      role: 'user',
      text: options.preamble?.turnContext
        ? `${options.request}\n\n${options.preamble.turnContext}`
        : options.request,
    },
  ];
  const system = [
    systemPrompt(options.preamble),
    ...(options.executeAfterApproval
      ? [
          "After the person's yes the host immediately executes and verifies that plan. Its tool result contains execution and verification. Do not execute it again. Report the verified change in one line, or explain what stopped. If more of the person's request remains, continue from the observed result.",
        ]
      : []),
  ].join('\n');
  // The person's own words: currencies they name are theirs to use.
  if (typeof options.session.noteRequest === 'function')
    options.session.noteRequest(options.request);
  // Remove complete old exchanges if their replay would crowd out this request.
  while (
    conversation.length > 1 &&
    options.meter.outputBudget(
      estimateInputTokens({
        system,
        tools: OPERATIONS_AGENT_TOOLS,
        conversation,
      }),
    ) === 0
  ) {
    const next = conversation.findIndex(
      (entry, i) => i > 0 && entry.role === 'user',
    );
    if (next < 0) break;
    conversation.splice(0, next);
  }
  const historyLength = conversation.length - 1;
  const started = performance.now();
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const startUsd = options.meter.usd;
  let toolCalls = 0;
  let turns = 0;
  const finish = (
    stop: AgentRunResult['stop'],
    answer: string,
    error?: string,
  ): AgentRunResult => {
    return {
      answer,
      stop,
      turns,
      toolCalls,
      usage: { ...usage },
      usd: options.meter.usd - startUsd,
      conversation,
      seconds: (performance.now() - started) / 1000,
      ...(error ? { error } : {}),
    };
  };
  const invoke = async (name: string, input: unknown) => {
    toolCalls += 1;
    options.onEvent?.({ kind: 'tool', name, input });
    const outcome = await options.session.call(
      name,
      input,
      options.signal ? { signal: options.signal } : {},
    );
    options.onEvent?.({ kind: 'result', name, ...outcome });
    return outcome;
  };
  const maximumTurns = options.maximumTurns ?? 40;
  while (turns < maximumTurns) {
    if (options.signal?.aborted)
      return finish('stopped', 'Stopped by the person.');
    if (options.meter.exhausted())
      return finish('spend-cap', 'Stopped: the run reached its spend cap.');
    turns += 1;
    let turn;
    let usd: number;
    let maxOutputTokens: number | undefined;
    options.onEvent?.({ kind: 'thinking' });
    try {
      ({ turn, usd, maxOutputTokens } = await meteredNext(
        options.model,
        options.meter,
        {
          system,
          tools: OPERATIONS_AGENT_TOOLS,
          conversation,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onEvent
            ? {
                onText: (delta: string) =>
                  options.onEvent?.({ kind: 'delta', text: delta }),
              }
            : {}),
        },
      ));
    } catch (error) {
      if (options.signal?.aborted)
        return finish('stopped', 'Stopped by the person.');
      if (error instanceof SpendCapReached) {
        if (turns === 1) conversation.splice(historyLength);
        return finish('spend-cap', 'Stopped: the run reached its spend cap.');
      }
      return finish(
        'model-error',
        'Stopped: the model call failed.',
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'model call failed',
      );
    }
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.cacheReadTokens += turn.usage.cacheReadTokens;
    usage.cacheWriteTokens += turn.usage.cacheWriteTokens;
    options.onEvent?.({
      kind: 'model',
      messages: conversation.length,
      stop: turn.stop,
      usage: turn.usage,
      usd,
    });
    if (turn.stop === 'limit' && turn.toolCalls.length > 0) {
      // Cut off at its output limit: its tool calls may be truncated and are
      // never run, and history keeps only its text, so no tool call waits
      // for a result on the next turn (end review X13).
      conversation.push({
        role: 'assistant',
        text: turn.text || '(cut off)',
        toolCalls: [],
      });
      return maxOutputTokens !== undefined &&
        maxOutputTokens < CALL_OUTPUT_CEILING
        ? finish('spend-cap', 'Stopped: the run reached its spend cap.')
        : finish(
            'model-error',
            'Stopped: the model reply was cut off.',
            'the reply reached its output limit inside a tool call',
          );
    }
    conversation.push({
      role: 'assistant',
      text: turn.text,
      toolCalls: turn.toolCalls,
      ...(turn.providerContent !== undefined
        ? { providerContent: turn.providerContent }
        : {}),
    });
    if (turn.text) options.onEvent?.({ kind: 'text', text: turn.text });
    if (turn.stop === 'refusal') return finish('refusal', turn.text);
    if (turn.toolCalls.length === 0) return finish('answered', turn.text);
    let customization = false;
    const answerCall = async (call: ToolCall) => {
      if (options.signal?.aborted) {
        return {
          id: call.id,
          content: JSON.stringify({ error: 'stopped by the person' }),
          isError: true,
        };
      }
      const approvalIndex =
        options.executeAfterApproval && call.name === 'erp_plan'
          ? options.session.approvals.length
          : undefined;
      const outcome = await invoke(call.name, call.input);
      if (
        turn.toolCalls.length === 1 &&
        call.name === 'erp_plan' &&
        !outcome.isError &&
        isRecord(outcome.content) &&
        outcome.content.outcome === 'customization-request'
      )
        customization = true;
      // Only the approval produced by this call may start a host execution.
      // The raw erp_plan remains non-mutating; risk-class approvals retain Undo.
      const grant =
        approvalIndex === undefined
          ? undefined
          : options.session.approvals[approvalIndex];
      let content = outcome.content;
      if (
        grant?.approved &&
        grant.by === 'person' &&
        !options.signal?.aborted
      ) {
        const execution = await invoke('erp_execute', {
          planId: grant.planId,
          executionIdempotencyKey: grant.planId,
        });
        // Even on Stop or a partial failure, verify the writes that did commit.
        const verification = await invoke('erp_verify', {
          operationSessionId: grant.planId,
        });
        content = {
          planId: grant.planId,
          approval: 'approved by the person',
          execution: execution.content,
          verification: verification.content,
        };
      }
      return {
        id: call.id,
        content: JSON.stringify(content),
        isError: outcome.isError,
      };
    };
    const results = [];
    const readOnly = turn.toolCalls.every(
      ({ name }) => name === 'erp_query' || name === 'erp_discover',
    );
    // A read retains its own gateway, typed provenance and tool-use ID.
    // Keep a mixed turn ordered, including any approval and subsequent writes.
    const width = readOnly ? 4 : 1;
    for (let i = 0; i < turn.toolCalls.length; i += width) {
      results.push(
        ...(await Promise.all(
          turn.toolCalls.slice(i, i + width).map(answerCall),
        )),
      );
    }
    conversation.push({ role: 'tool', results });
    if (customization && !options.signal?.aborted)
      return {
        ...finish('answered', 'Customization requested.'),
        handoff: { change: options.request },
      };
    if (options.signal?.aborted)
      return finish('stopped', 'Stopped by the person.');
  }
  return finish('turn-limit', 'Stopped: the run reached its turn limit.');
}

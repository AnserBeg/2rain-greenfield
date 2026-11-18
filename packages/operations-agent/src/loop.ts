/**
 * The agent loop: the model proposes tool calls, the session runs them, and
 * the loop stops on a final answer, a turn limit or the spend cap. The cap is
 * checked before every model call, so a run never starts a call once its
 * spend has reached the cap.
 */
import type { ConversationEntry, ModelAdapter, ModelUsage } from './model.js';
import type { AgentScreen, OperationsAgentSession } from './session.js';
import {
  customizeHandoff,
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
  #usd = 0;
  readonly #prices: ModelPrices | null;
  readonly capUsd: number;
  constructor(prices: ModelPrices | null, capUsd: number) {
    this.#prices = prices;
    this.capUsd = capUsd;
  }
  get usd(): number {
    return this.#usd;
  }
  charge(usage: ModelUsage): number {
    if (!this.#prices) return 0;
    const cost =
      (usage.inputTokens * this.#prices.input +
        usage.outputTokens * this.#prices.output +
        usage.cacheReadTokens * this.#prices.cacheRead +
        usage.cacheWriteTokens * this.#prices.cacheWrite) /
      1_000_000;
    this.#usd += cost;
    return cost;
  }
  exhausted(): boolean {
    return this.#usd >= this.capUsd;
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
   * Set when the model's whole final answer is the typed customization
   * handoff (end review X11); hosts read this, never the answer's text.
   */
  readonly handoff?: { readonly change: string };
}

export interface AgentRunOptions {
  readonly model: ModelAdapter;
  readonly session: OperationsAgentSession;
  readonly request: string;
  readonly meter: SpendMeter;
  readonly maximumTurns?: number;
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
  const system = systemPrompt(options.preamble);
  // The person's own words: currencies they name are theirs to use.
  if (typeof options.session.noteRequest === 'function')
    options.session.noteRequest(options.request);
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
    const change = stop === 'answered' ? customizeHandoff(answer) : null;
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
      ...(change !== null ? { handoff: { change } } : {}),
    };
  };
  const maximumTurns = options.maximumTurns ?? 40;
  while (turns < maximumTurns) {
    if (options.signal?.aborted)
      return finish('stopped', 'Stopped by the person.');
    if (options.meter.exhausted())
      return finish('spend-cap', 'Stopped: the run reached its spend cap.');
    turns += 1;
    let turn;
    options.onEvent?.({ kind: 'thinking' });
    try {
      turn = await options.model.next({
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
      });
    } catch (error) {
      if (options.signal?.aborted)
        return finish('stopped', 'Stopped by the person.');
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
    const usd = options.meter.charge(turn.usage);
    options.onEvent?.({
      kind: 'model',
      messages: conversation.length,
      stop: turn.stop,
      usage: turn.usage,
      usd,
    });
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
    const results = [];
    for (const call of turn.toolCalls) {
      if (options.signal?.aborted) {
        // Every tool_use needs its result before the next model call.
        results.push({
          id: call.id,
          content: JSON.stringify({ error: 'stopped by the person' }),
          isError: true,
        });
        continue;
      }
      toolCalls += 1;
      options.onEvent?.({ kind: 'tool', name: call.name, input: call.input });
      const outcome = await options.session.call(
        call.name,
        call.input,
        options.signal ? { signal: options.signal } : {},
      );
      options.onEvent?.({
        kind: 'result',
        name: call.name,
        isError: outcome.isError,
        content: outcome.content,
      });
      results.push({
        id: call.id,
        content: JSON.stringify(outcome.content),
        isError: outcome.isError,
      });
    }
    conversation.push({ role: 'tool', results });
    if (options.signal?.aborted)
      return finish('stopped', 'Stopped by the person.');
  }
  return finish('turn-limit', 'Stopped: the run reached its turn limit.');
}

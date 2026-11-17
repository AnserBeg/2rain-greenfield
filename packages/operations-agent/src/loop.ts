/**
 * The agent loop: the model proposes tool calls, the session runs them, and
 * the loop stops on a final answer, a turn limit or the spend cap. The cap is
 * checked before every model call, so a run never starts a call once its
 * spend has reached the cap.
 */
import type { ConversationEntry, ModelAdapter, ModelUsage } from './model.js';
import type { OperationsAgentSession } from './session.js';
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
    'answered' | 'turn-limit' | 'spend-cap' | 'refusal' | 'model-error';
  readonly turns: number;
  readonly toolCalls: number;
  readonly usage: ModelUsage;
  readonly usd: number;
  readonly conversation: readonly ConversationEntry[];
  readonly error?: string;
}

export interface AgentRunOptions {
  readonly model: ModelAdapter;
  readonly session: OperationsAgentSession;
  readonly request: string;
  readonly meter: SpendMeter;
  readonly maximumTurns?: number;
  readonly onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | {
      readonly kind: 'model';
      readonly messages: number;
      readonly stop: string;
      readonly usage: ModelUsage;
      readonly usd: number;
    }
  | { readonly kind: 'text'; readonly text: string }
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
    { role: 'user', text: options.request },
  ];
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
  ): AgentRunResult => ({
    answer,
    stop,
    turns,
    toolCalls,
    usage: { ...usage },
    usd: options.meter.usd - startUsd,
    conversation,
    ...(error ? { error } : {}),
  });
  const maximumTurns = options.maximumTurns ?? 40;
  while (turns < maximumTurns) {
    if (options.meter.exhausted())
      return finish('spend-cap', 'Stopped: the run reached its spend cap.');
    turns += 1;
    let turn;
    try {
      turn = await options.model.next({
        system: OPERATIONS_AGENT_SYSTEM_PROMPT,
        tools: OPERATIONS_AGENT_TOOLS,
        conversation,
      });
    } catch (error) {
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
      toolCalls += 1;
      options.onEvent?.({ kind: 'tool', name: call.name, input: call.input });
      const outcome = await options.session.call(call.name, call.input);
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
  }
  return finish('turn-limit', 'Stopped: the run reached its turn limit.');
}

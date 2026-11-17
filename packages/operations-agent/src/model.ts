/**
 * The one adapter interface every model provider sits behind, and the
 * scripted fake model tests and CI use. A provider's SDK is imported only by
 * its adapter file in this package.
 */
import type { ModelToolDefinition } from './tools.js';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type ConversationEntry =
  | { readonly role: 'user'; readonly text: string }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
      /** The provider's own content, replayed unchanged (thinking blocks). */
      readonly providerContent?: unknown;
    }
  | {
      readonly role: 'tool';
      readonly results: readonly {
        readonly id: string;
        readonly content: string;
        readonly isError: boolean;
      }[];
    };

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ModelTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stop: 'end' | 'tools' | 'limit' | 'refusal';
  readonly usage: ModelUsage;
  readonly providerContent?: unknown;
}

export interface ModelAdapter {
  /** The provider's model id, e.g. `claude-opus-5-5`. */
  readonly modelId: string;
  next(request: {
    readonly system: string;
    readonly tools: readonly ModelToolDefinition[];
    readonly conversation: readonly ConversationEntry[];
  }): Promise<ModelTurn>;
}

/**
 * A scripted model: each step sees the conversation so far and returns the
 * next turn. Steps can read earlier tool results (record ids, plan ids), so a
 * script is a deterministic reference solution, not a recording.
 */
export type ScriptStep = (conversation: readonly ConversationEntry[]) => {
  text?: string;
  toolCalls?: readonly Omit<ToolCall, 'id'>[];
};

export function scriptedModel(steps: readonly ScriptStep[]): ModelAdapter {
  let index = 0;
  let calls = 0;
  return {
    modelId: 'scripted',
    next({ conversation }) {
      const step = steps[index];
      index += 1;
      if (!step)
        return Promise.resolve({
          text: 'script exhausted',
          toolCalls: [],
          stop: 'end',
          usage: zeroUsage,
        });
      const turn = step(conversation);
      const toolCalls = (turn.toolCalls ?? []).map((call) => {
        calls += 1;
        return { ...call, id: `scripted-${String(calls)}` };
      });
      return Promise.resolve({
        text: turn.text ?? '',
        toolCalls,
        stop: toolCalls.length > 0 ? 'tools' : 'end',
        usage: zeroUsage,
      });
    },
  };
}

const zeroUsage: ModelUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** The parsed content of the last tool result in a conversation. */
export function lastToolResult(
  conversation: readonly ConversationEntry[],
): Record<string, unknown> {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index]!;
    if (entry.role === 'tool') {
      const last = entry.results.at(-1);
      return last ? (JSON.parse(last.content) as Record<string, unknown>) : {};
    }
  }
  return {};
}

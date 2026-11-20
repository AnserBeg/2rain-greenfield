/**
 * The Anthropic adapter: the only file that imports the provider SDK. One
 * Messages API call per turn, adaptive thinking (the model's default), effort
 * set explicitly, the tool list and system prompt cached. Thinking blocks are
 * replayed unchanged on the next turn, as the API requires.
 */
import Anthropic from '@anthropic-ai/sdk';

import type { ModelKey } from './keys.js';
import type { ConversationEntry, ModelAdapter, ModelTurn } from './model.js';
import { asData } from './tools.js';

/** Stated in the packet record; the owner may name another. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export const SONNET_MODEL = 'claude-sonnet-5-5';
// USD per million tokens, Anthropic's first-party API, 2026-11-19.
export const SONNET_PRICES = Object.freeze({
  input: 2,
  output: 10,
  cacheRead: 0.1,
  cacheWrite: 2.5,
});

/** Route short, single requests without inspecting or naming any module. */
export function assistantRoute(
  request: string,
  modelOverride?: string,
): { modelId: string; effort: 'low' | 'high' } {
  const fallback = {
    modelId: modelOverride ?? DEFAULT_ANTHROPIC_MODEL,
    effort: 'high',
  } as const;
  const text = request.trim();
  if (
    modelOverride ||
    text.length > 200 ||
    /[;\n]|\b(?:and|then|after|before|unless|except|each of|all of)\b/iu.test(
      text,
    )
  )
    return fallback;
  const create = /^(?:add|create) (?:a |an |one )/iu.test(text);
  if (create) return { modelId: SONNET_MODEL, effort: 'low' };
  return fallback;
}

export interface AnthropicModelOptions {
  readonly key: ModelKey;
  readonly modelId?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxTokens?: number;
  /** Milliseconds per request; the SDK retries 408/429/5xx twice. */
  readonly timeoutMs?: number;
  /** Tests point the client at a local stand-in; production never sets it. */
  readonly baseURL?: string;
}

export function anthropicModel(options: AnthropicModelOptions): ModelAdapter {
  const client = new Anthropic({
    apiKey: options.key.reveal(),
    maxRetries: 2,
    timeout: options.timeoutMs ?? 300_000,
    ...(options.baseURL ? { baseURL: options.baseURL, maxRetries: 0 } : {}),
  });
  const modelId = options.modelId ?? DEFAULT_ANTHROPIC_MODEL;
  return {
    modelId,
    async next({
      system,
      tools,
      conversation,
      signal,
      onText,
      maxOutputTokens,
    }): Promise<ModelTurn> {
      let response: Anthropic.Message;
      try {
        const stream = client.messages.stream(
          {
            model: modelId,
            max_tokens: Math.min(
              options.maxTokens ?? 16_000,
              maxOutputTokens ?? Number.POSITIVE_INFINITY,
            ),
            cache_control: { type: 'ephemeral' },
            output_config: { effort: options.effort ?? 'high' },
            // An explicit breakpoint on the system prompt (with the business
            // map) gives every conversation of the same person and release a
            // read point; the top-level one caches the growing conversation.
            system: [
              {
                type: 'text',
                text: system,
                cache_control: { type: 'ephemeral' },
              },
            ],
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
            messages: toMessages(conversation),
          },
          signal ? { signal } : {},
        );
        if (onText) stream.on('text', (delta) => onText(delta));
        response = await stream.finalMessage();
      } catch (error) {
        // Never let a provider error carry the key outward.
        const message = error instanceof Error ? error.message : String(error);
        const scrubbed = new Error(
          message.split(options.key.reveal()).join('[model key]'),
        );
        scrubbed.name =
          error instanceof Anthropic.APIError
            ? `AnthropicAPIError(${String(error.status)})`
            : 'AnthropicModelError';
        throw scrubbed;
      }
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      const toolCalls = response.content
        .filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        )
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: block.input,
        }));
      return {
        text,
        toolCalls,
        // A reply cut off at its output limit is 'limit' even when it holds
        // a tool call: that call may be truncated and is never run.
        stop:
          response.stop_reason === 'refusal'
            ? 'refusal'
            : response.stop_reason === 'max_tokens'
              ? 'limit'
              : toolCalls.length > 0
                ? 'tools'
                : 'end',
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        providerContent: response.content,
      };
    },
  };
}

/**
 * The conversation as Messages API turns. A tool's result reaches the model
 * inside <tool-data>, which the system prompt calls data (end review X11);
 * the session and the scripted models keep the raw JSON.
 */
export function toMessages(
  conversation: readonly ConversationEntry[],
): Anthropic.MessageParam[] {
  return conversation.map((entry): Anthropic.MessageParam => {
    if (entry.role === 'user') return { role: 'user', content: entry.text };
    if (entry.role === 'assistant')
      return {
        role: 'assistant',
        content: (entry.providerContent as
          Anthropic.ContentBlockParam[] | undefined) ?? [
          ...(entry.text ? [{ type: 'text' as const, text: entry.text }] : []),
          ...entry.toolCalls.map((call) => ({
            type: 'tool_use' as const,
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ],
      };
    return {
      role: 'user',
      content: entry.results.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.id,
        content: asData('tool-data', result.content),
        ...(result.isError ? { is_error: true } : {}),
      })),
    };
  });
}

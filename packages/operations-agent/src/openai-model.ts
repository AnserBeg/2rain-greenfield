/**
 * The OpenAI adapter (AI-BUILD-1 slice 3 bake-off): one Chat Completions call
 * per turn, the tools offered as functions, reasoning effort set explicitly.
 * It uses `fetch` only, so no provider SDK enters the tree. The key is a
 * `ModelKey` from the key file; it is sent as the bearer token and never
 * appears in an error, a result or a log line.
 */
import type { ModelKey } from './keys.js';
import type { ConversationEntry, ModelAdapter, ModelTurn } from './model.js';

export interface OpenAiModelOptions {
  readonly key: ModelKey;
  readonly modelId: string;
  readonly effort?: 'minimal' | 'low' | 'medium' | 'high';
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  /** Tests point the client at a local stand-in; production never sets it. */
  readonly baseURL?: string;
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

/** The request body for one turn; shared with the Batch API path. */
export function openAiChatBody(
  options: Pick<OpenAiModelOptions, 'modelId' | 'effort' | 'maxTokens'>,
  request: Pick<
    Parameters<ModelAdapter['next']>[0],
    'system' | 'tools' | 'conversation'
  >,
): Record<string, unknown> {
  return {
    model: options.modelId,
    max_completion_tokens: options.maxTokens ?? 8_000,
    ...(options.effort ? { reasoning_effort: options.effort } : {}),
    messages: [
      { role: 'system', content: request.system },
      ...toMessages(request.conversation),
    ],
    tools: request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  };
}

export interface OpenAiChatResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: {
        id: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** One response as a turn; used for live calls and Batch API results. */
export function openAiTurn(response: OpenAiChatResponse): ModelTurn {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const toolCalls = (message?.tool_calls ?? []).map((call) => {
    let input: unknown;
    try {
      input = JSON.parse(call.function?.arguments ?? '{}');
    } catch {
      input = {
        unparsedArguments: (call.function?.arguments ?? '').slice(0, 2000),
      };
    }
    return { id: call.id, name: call.function?.name ?? '', input };
  });
  const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: (message?.content ?? '').trim(),
    toolCalls,
    stop: message?.refusal
      ? 'refusal'
      : choice?.finish_reason === 'length'
        ? 'limit'
        : toolCalls.length > 0
          ? 'tools'
          : 'end',
    usage: {
      // Anthropic's convention: input excludes cache reads.
      inputTokens: Math.max(0, (response.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  };
}

export function openAiModel(options: OpenAiModelOptions): ModelAdapter {
  const base = options.baseURL ?? OPENAI_BASE_URL;
  return {
    modelId: options.modelId,
    async next(request): Promise<ModelTurn> {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 300_000,
      );
      request.signal?.addEventListener('abort', () => controller.abort());
      try {
        let last = '';
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.key.reveal()}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(
              openAiChatBody(
                {
                  ...options,
                  maxTokens: Math.min(
                    options.maxTokens ?? 8_000,
                    request.maxOutputTokens ?? Number.POSITIVE_INFINITY,
                  ),
                },
                request,
              ),
            ),
            signal: controller.signal,
          });
          if (response.ok)
            return openAiTurn((await response.json()) as OpenAiChatResponse);
          // The body may echo request details; keep only a bounded,
          // key-scrubbed status line.
          last = `${String(response.status)} ${(await response.text())
            .split(options.key.reveal())
            .join('[model key]')
            .slice(0, 300)}`;
          if (![408, 409, 429, 500, 502, 503, 504].includes(response.status))
            break;
          await new Promise((resolve) =>
            setTimeout(resolve, 2_000 * (attempt + 1)),
          );
        }
        const error = new Error(last);
        error.name = 'OpenAiAPIError';
        throw error;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const scrubbed = new Error(
          message.split(options.key.reveal()).join('[model key]'),
        );
        scrubbed.name =
          error instanceof Error && error.name === 'OpenAiAPIError'
            ? 'OpenAiAPIError'
            : 'OpenAiModelError';
        throw scrubbed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function toMessages(conversation: readonly ConversationEntry[]): ChatMessage[] {
  return conversation.flatMap((entry): ChatMessage[] => {
    if (entry.role === 'user') return [{ role: 'user', content: entry.text }];
    if (entry.role === 'assistant')
      return [
        {
          role: 'assistant',
          content: entry.text || null,
          ...(entry.toolCalls.length
            ? {
                tool_calls: entry.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.input ?? {}),
                  },
                })),
              }
            : {}),
        },
      ];
    return entry.results.map((result) => ({
      role: 'tool' as const,
      tool_call_id: result.id,
      content: result.content,
    }));
  });
}

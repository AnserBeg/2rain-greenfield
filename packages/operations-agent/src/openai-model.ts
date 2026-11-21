/**
 * The OpenAI adapter (AI-BUILD-1 slice 3 bake-off): one Responses API call
 * per turn, the tools offered as functions, reasoning effort set explicitly
 * (Chat Completions refuses function tools with reasoning on these models).
 * It uses `fetch` only, so no provider SDK enters the tree. The key is a
 * `ModelKey` from the key file; it is sent as the bearer token and never
 * appears in an error, a result or a log line. The response's own output
 * items (reasoning included) are replayed unchanged on the next turn.
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

type InputItem = Record<string, unknown>;

/** The request body for one turn; shared with the Batch API path. */
export function openAiResponsesBody(
  options: Pick<OpenAiModelOptions, 'modelId' | 'effort' | 'maxTokens'>,
  request: Pick<
    Parameters<ModelAdapter['next']>[0],
    'system' | 'tools' | 'conversation'
  >,
): Record<string, unknown> {
  return {
    model: options.modelId,
    instructions: request.system,
    max_output_tokens: options.maxTokens ?? 8_000,
    ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
    input: toInput(request.conversation),
    tools: request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
  };
}

export interface OpenAiResponse {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: { type?: string; text?: string; refusal?: string }[];
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/** One response as a turn; used for live calls and Batch API results. */
export function openAiTurn(response: OpenAiResponse): ModelTurn {
  const output = response.output ?? [];
  const toolCalls = output
    .filter((item) => item.type === 'function_call')
    .map((item) => {
      let input: unknown;
      try {
        input = JSON.parse(item.arguments ?? '{}');
      } catch {
        input = { unparsedArguments: (item.arguments ?? '').slice(0, 2000) };
      }
      return { id: item.call_id ?? '', name: item.name ?? '', input };
    });
  const parts = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);
  const text = parts
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    text,
    toolCalls,
    stop: parts.some((part) => part.type === 'refusal')
      ? 'refusal'
      : response.status === 'incomplete' &&
          response.incomplete_details?.reason === 'max_output_tokens'
        ? 'limit'
        : toolCalls.length > 0
          ? 'tools'
          : 'end',
    usage: {
      // Anthropic's convention: input excludes cache reads.
      inputTokens: Math.max(0, (response.usage?.input_tokens ?? 0) - cached),
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    providerContent: output,
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
          const response = await fetch(`${base}/responses`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.key.reveal()}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(
              openAiResponsesBody(
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
            return openAiTurn((await response.json()) as OpenAiResponse);
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

function toInput(conversation: readonly ConversationEntry[]): InputItem[] {
  return conversation.flatMap((entry): InputItem[] => {
    if (entry.role === 'user') return [{ role: 'user', content: entry.text }];
    if (entry.role === 'assistant') {
      // The response's own items, reasoning included, go back unchanged.
      if (Array.isArray(entry.providerContent))
        return entry.providerContent as InputItem[];
      return [
        ...(entry.text ? [{ role: 'assistant', content: entry.text }] : []),
        ...entry.toolCalls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        })),
      ];
    }
    return entry.results.map((result) => ({
      type: 'function_call_output',
      call_id: result.id,
      output: result.content,
    }));
  });
}

/**
 * Minimal client for an OpenAI-compatible `/chat/completions` endpoint,
 * shared by the summarizer and the S1-mini text normalizer. `fetchImpl` is
 * injectable for tests.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export interface ChatCompletionOptions {
  /** Sampling temperature; defaults to 0.2. */
  temperature?: number;
  /** Sent as `max_tokens` when set. */
  maxTokens?: number;
  /**
   * Extra top-level fields merged into the JSON body, for server-specific
   * flags such as llama-server's `chat_template_kwargs`.
   */
  extraBody?: Record<string, unknown>;
  /** Forwarded to fetch so a caller can time the request out. */
  signal?: AbortSignal;
}

/** A non-2xx response; `status` lets callers add a targeted hint. */
export class ChatCompletionHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`LLM request failed: HTTP ${status} ${body}`.trim());
    this.name = "ChatCompletionHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * POST `messages` to `<base>/chat/completions` and return the first choice's
 * message content. The Bearer header is sent only when a key is configured.
 */
export async function callChatCompletion(
  settings: LlmSettings,
  messages: ChatMessage[],
  fetchImpl?: typeof fetch,
  options: ChatCompletionOptions = {},
): Promise<string> {
  const doFetch = fetchImpl ?? fetch;
  const base = settings.llmBaseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.llmApiKey) {
    headers["Authorization"] = `Bearer ${settings.llmApiKey}`;
  }
  const body: Record<string, unknown> = {
    model: settings.llmModel,
    messages,
    temperature: options.temperature ?? 0.2,
  };
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  Object.assign(body, options.extraBody ?? {});

  const res = await doFetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ChatCompletionHttpError(res.status, text);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response had no message content.");
  }
  return content;
}

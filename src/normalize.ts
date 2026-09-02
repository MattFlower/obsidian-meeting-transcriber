import {
  callChatCompletion,
  ChatCompletionHttpError,
  type ChatMessage,
} from "./chat-completion";

/**
 * Text normalization of raw ASR transcripts with S1-mini by Superwhisper
 * (https://huggingface.co/superwhisper/s1-mini): fillers removed, false
 * starts and self-corrections resolved, punctuation and capitalization
 * applied, spoken numbers, dates, times and currency written out. English
 * only.
 *
 * The model is served by a local OpenAI-compatible server (Ollama,
 * llama-server, LM Studio) running the official GGUF build. Two things the
 * model card insists on, and this module enforces:
 *
 *  - The system prompt and the control line are the input format the model
 *    was trained on. They are sent verbatim; any other wording, or a control
 *    value outside the trained sets, makes the model hallucinate.
 *  - Thinking must be off (the assistant turn starts with an empty <think>
 *    block). `chat_template_kwargs.enable_thinking=false` is sent for
 *    servers that honor it; Ollama users create the model from Superwhisper's
 *    Modelfile, which hard-codes the template. A leading think block in a
 *    reply is stripped defensively either way.
 *
 * Decoding is greedy (temperature 0), long transcripts are chunked at
 * sentence boundaries, and a filler-only chunk legitimately comes back as an
 * empty string. Pure and injectable so it can be tested headlessly.
 */

/** Required verbatim: the model was never trained without it. */
export const S1_MINI_SYSTEM_PROMPT =
  "You are a text normalizer for speech-to-text transcripts. The input " +
  "begins with a control line specifying the styling, structure, and " +
  "context settings; clean the transcript to match those settings and " +
  "output only the cleaned text.";

export const NORMALIZER_STYLINGS = [
  "casual",
  "semi-casual",
  "semi-formal",
  "formal",
] as const;
export type NormalizerStyling = (typeof NORMALIZER_STYLINGS)[number];

export const NORMALIZER_STRUCTURES = ["prose", "lists"] as const;
export type NormalizerStructure = (typeof NORMALIZER_STRUCTURES)[number];

/** Meeting transcripts are never emails, so the context axis is fixed. */
export const NORMALIZER_CONTEXT = "general";

export const DEFAULT_NORMALIZER_STYLING: NormalizerStyling = "semi-formal";
export const DEFAULT_NORMALIZER_STRUCTURE: NormalizerStructure = "prose";

/**
 * Words per request. The model card recommends passes under ~1,000 tokens;
 * 500 words is roughly 700 tokens, leaving headroom for the prompt and for
 * the token estimate being low.
 */
export const NORMALIZER_CHUNK_WORDS = 500;

/** Per-chunk request timeout; a 0.6B model on CPU can take a minute. */
export const NORMALIZER_TIMEOUT_MS = 180_000;

/**
 * Sanity guard: a chunk longer than this many words is expected to come back
 * non-empty and within the length ratio window. Outside it the raw chunk is
 * kept, which catches repetition loops, garbling, and a server that has
 * thinking enabled (blank replies) without a second model call.
 */
export const GUARD_MIN_WORDS = 20;
export const GUARD_MIN_RATIO = 0.4;
export const GUARD_MAX_RATIO = 1.5;

/**
 * The normalizer-relevant subset of plugin settings (structurally satisfied
 * by TranscriberSettings).
 */
export interface NormalizerSettings {
  normalizerBaseUrl: string;
  normalizerApiKey: string;
  normalizerModel: string;
  normalizerStyling: NormalizerStyling;
  normalizerStructure: NormalizerStructure;
}

export interface NormalizeRequest {
  messages: ChatMessage[];
  maxTokens: number;
}

/**
 * Backend seam: turn one fully built request into the model's raw reply.
 * Only the HTTP backend exists today; an in-process runtime could slot in
 * here without touching the chunking or guards.
 */
export type NormalizeBackend = (request: NormalizeRequest) => Promise<string>;

export interface NormalizeProgress {
  /** 1-based index of the chunk about to be sent. */
  chunk: number;
  total: number;
}

/** Injectable dependencies for normalizeTranscript (tests, hosts). */
export interface NormalizerDeps {
  fetchImpl?: typeof fetch;
  backend?: NormalizeBackend;
  timeoutMs?: number;
  onProgress?: (progress: NormalizeProgress) => void;
}

export interface NormalizeResult {
  /** Normalized transcript, chunks joined as paragraphs; "" when nothing remains. */
  text: string;
  chunks: number;
  /** Chunks whose raw text was kept because the reply failed the guard. */
  fallbackChunks: number;
  /** Chunks the model answered with an empty string. */
  emptyChunks: number;
}

/**
 * Validate the control values from settings, falling back to the defaults:
 * a value outside the trained sets (a hand-edited data.json, say) would
 * garble the output rather than fail.
 */
export function resolveControl(settings: NormalizerSettings): {
  styling: NormalizerStyling;
  structure: NormalizerStructure;
} {
  const styling = (NORMALIZER_STYLINGS as readonly string[]).includes(
    settings.normalizerStyling,
  )
    ? settings.normalizerStyling
    : DEFAULT_NORMALIZER_STYLING;
  const structure = (NORMALIZER_STRUCTURES as readonly string[]).includes(
    settings.normalizerStructure,
  )
    ? settings.normalizerStructure
    : DEFAULT_NORMALIZER_STRUCTURE;
  return { styling, structure };
}

export function buildControlLine(
  styling: NormalizerStyling,
  structure: NormalizerStructure,
): string {
  return `[Styling: ${styling}] [Structure: ${structure}] [Context: ${NORMALIZER_CONTEXT}]`;
}

/** The system prompt plus a user turn of control line, newline, raw text. */
export function buildNormalizeMessages(
  settings: NormalizerSettings,
  chunk: string,
): ChatMessage[] {
  const { styling, structure } = resolveControl(settings);
  return [
    { role: "system", content: S1_MINI_SYSTEM_PROMPT },
    {
      role: "user",
      content: `${buildControlLine(styling, structure)}\n${chunk}`,
    },
  ];
}

export function countWords(text: string): number {
  const words = text.match(/\S+/g);
  return words ? words.length : 0;
}

/**
 * Rough token count without a tokenizer: the larger of chars/4 and
 * words×1.3, which over-estimates for ordinary English and so keeps
 * `max_tokens` on the safe side.
 */
export function estimateTokens(text: string): number {
  return Math.max(
    Math.ceil(text.length / 4),
    Math.ceil(countWords(text) * 1.3),
  );
}

/** The model card's ceiling: output tracks input, 1.3 × tokens + 32. */
export function maxTokensFor(text: string): number {
  return Math.ceil(1.3 * estimateTokens(text)) + 32;
}

/**
 * A sentence ends at terminal punctuation (optionally followed by a closing
 * quote or bracket) and whitespace. `3.15pm` and `support@x.com` have no
 * whitespace after the dot, so they are not boundaries.
 */
const SENTENCE_BOUNDARY = /(?<=[.!?]["')\]]*)\s+/;

/**
 * Split a transcript into chunks of at most `maxWords` words, cutting only at
 * sentence boundaries (paragraph breaks are always boundaries too). A
 * sentence longer than the limit, as a punctuation-less run would be, is
 * hard-split on word count. Sentences are packed greedily in order, so a
 * chunk may span paragraphs but never ends mid-sentence except in the
 * hard-split case. Empty input yields no chunks.
 */
export function chunkTranscript(
  text: string,
  maxWords = NORMALIZER_CHUNK_WORDS,
): string[] {
  const limit = Math.max(1, Math.floor(maxWords));
  const units: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const flat = paragraph.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    for (const sentence of flat.split(SENTENCE_BOUNDARY)) {
      const words = sentence.split(" ").filter((w) => w.length > 0);
      if (words.length === 0) continue;
      if (words.length <= limit) {
        units.push(words.join(" "));
        continue;
      }
      for (let i = 0; i < words.length; i += limit) {
        units.push(words.slice(i, i + limit).join(" "));
      }
    }
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const unit of units) {
    const n = countWords(unit);
    if (current.length > 0 && count + n > limit) {
      chunks.push(current.join(" "));
      current = [];
      count = 0;
    }
    current.push(unit);
    count += n;
  }
  if (current.length > 0) chunks.push(current.join(" "));
  return chunks;
}

/**
 * Drop a leading `<think>…</think>` block (or an unterminated `<think>…`)
 * from a reply. A server with thinking left on emits one; the text after it,
 * if any, is what the model actually produced.
 */
export function stripThinkBlock(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?(?:<\/think>|$)/i, "").trim();
}

function isNetworkError(err: Error): boolean {
  return (
    err instanceof TypeError ||
    /ECONNREFUSED|ENOTFOUND|fetch failed|Failed to fetch|NetworkError/i.test(
      err.message,
    )
  );
}

/**
 * The HTTP backend: one OpenAI-compatible chat completion per chunk with
 * greedy decoding, a sized `max_tokens`, the thinking-off template flag and
 * a timeout. Errors are rewritten into messages that say what to fix.
 */
export function httpNormalizeBackend(
  settings: NormalizerSettings,
  fetchImpl?: typeof fetch,
  timeoutMs = NORMALIZER_TIMEOUT_MS,
): NormalizeBackend {
  const base = settings.normalizerBaseUrl.replace(/\/+$/, "");
  const llm = {
    llmBaseUrl: settings.normalizerBaseUrl,
    llmApiKey: settings.normalizerApiKey,
    llmModel: settings.normalizerModel,
  };
  return async ({ messages, maxTokens }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await callChatCompletion(llm, messages, fetchImpl, {
        temperature: 0,
        maxTokens,
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(
          `S1-mini request timed out after ${Math.ceil(timeoutMs / 1000)} s.`,
        );
      }
      if (e instanceof ChatCompletionHttpError) {
        if (e.status === 404) {
          throw new Error(
            `${e.message}. Model "${settings.normalizerModel}" was not ` +
              "found on the server: check the S1-mini model name in " +
              "settings (for Ollama, run `ollama create s1-mini -f " +
              "Modelfile` first).",
          );
        }
        throw e;
      }
      const err = e instanceof Error ? e : new Error(String(e));
      if (isNetworkError(err)) {
        throw new Error(
          `Could not reach the S1-mini server at ${base}. Is Ollama / ` +
            `llama-server / LM Studio running? (${err.message})`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

const THINKING_HINT =
  "S1-mini returned no text for any chunk. This almost always means " +
  "thinking mode is still on in the server: llama-server needs --jinja " +
  "--chat-template-kwargs '{\"enable_thinking\":false}', Ollama needs the " +
  "model created from Superwhisper's Modelfile, and LM Studio needs its " +
  "thinking toggle off. See \"Text normalization\" in the README.";

/**
 * Normalize a whole transcript: chunk it, send the chunks one at a time
 * (local servers serialize anyway, and order is preserved), strip any think
 * block, apply the sanity guard, and join the kept chunks as paragraphs.
 *
 * Guard rules per chunk: an empty reply to a short chunk (≤ GUARD_MIN_WORDS)
 * is a legitimate "nothing but filler" and contributes nothing; an empty or
 * wildly resized reply to a longer chunk keeps the raw text instead. When
 * every chunk of a non-trivial transcript comes back empty the whole run is
 * an error naming the likely cause, so a misconfigured server does not
 * silently pass the raw text through as "normalized".
 */
export async function normalizeTranscript(
  settings: NormalizerSettings,
  transcript: string,
  deps: NormalizerDeps = {},
): Promise<NormalizeResult> {
  if (!settings.normalizerBaseUrl.trim() || !settings.normalizerModel.trim()) {
    throw new Error(
      "Set the S1-mini server URL and model name in settings first.",
    );
  }
  const backend =
    deps.backend ??
    httpNormalizeBackend(settings, deps.fetchImpl, deps.timeoutMs);
  const chunks = chunkTranscript(transcript);
  const result: NormalizeResult = {
    text: "",
    chunks: chunks.length,
    fallbackChunks: 0,
    emptyChunks: 0,
  };
  if (chunks.length === 0) return result;

  const kept: string[] = [];
  let anyText = false;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    deps.onProgress?.({ chunk: i + 1, total: chunks.length });
    const reply = await backend({
      messages: buildNormalizeMessages(settings, chunk),
      maxTokens: maxTokensFor(chunk),
    });
    const out = stripThinkBlock(reply);
    const words = countWords(chunk);
    if (out === "") {
      result.emptyChunks += 1;
      if (words > GUARD_MIN_WORDS) {
        result.fallbackChunks += 1;
        kept.push(chunk);
      }
      continue;
    }
    anyText = true;
    const ratio = out.length / chunk.length;
    if (
      words > GUARD_MIN_WORDS &&
      (ratio < GUARD_MIN_RATIO || ratio > GUARD_MAX_RATIO)
    ) {
      result.fallbackChunks += 1;
      kept.push(chunk);
      continue;
    }
    kept.push(out);
  }

  if (!anyText && countWords(transcript) > GUARD_MIN_WORDS) {
    throw new Error(THINKING_HINT);
  }
  result.text = kept.join("\n\n");
  return result;
}

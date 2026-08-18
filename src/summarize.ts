export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SummaryResult {
  summary: string;
  description: string;
  tags: string[];
}

export interface LlmSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

/**
 * Build the chat messages asking the model to return strict JSON with a
 * summary, a one-line description, and topic tags. Pure so it can be tested.
 */
export function buildSummarizePrompt(transcript: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You convert meeting transcripts into structured, searchable notes. " +
        "Respond with ONLY a JSON object, no surrounding prose, matching exactly " +
        'this shape: {"summary": string, "description": string, "tags": string[]}. ' +
        "summary is a concise 3-6 sentence recap of the meeting. " +
        "description is a single sentence suitable for search. " +
        "tags is an array of 3-8 short lowercase kebab-case topic tags.",
    },
    {
      role: "user",
      content: `Transcript:\n"""\n${transcript}\n"""`,
    },
  ];
}

/**
 * Sanitize an arbitrary value into a list of Obsidian-legal tags: lowercase
 * kebab form, illegal characters replaced, de-duplicated (case-insensitive),
 * capped at 8. Pure so it can be tested.
 */
export function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_/-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-/]+/, "")
      .replace(/[-/]+$/, "");
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Parse the model's response into a SummaryResult. Tolerant of code fences
 * and surrounding prose: it extracts the outermost JSON object and validates
 * its shape. Throws with a useful message when nothing usable is found.
 * Pure so it can be tested.
 */
export function parseSummaryResponse(text: string): SummaryResult {
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in summarizer response.");
  }
  const jsonStr = candidate.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Invalid JSON in summarizer response: ${(e as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Summarizer response JSON is not an object.");
  }

  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const description =
    typeof obj.description === "string" ? obj.description.trim() : "";
  const tags = sanitizeTags(obj.tags);

  if (!summary && !description && tags.length === 0) {
    throw new Error(
      "Summarizer response had no usable summary, description, or tags.",
    );
  }
  return { summary, description, tags };
}

/**
 * Call an OpenAI-compatible /chat/completions endpoint and return the message
 * content. `fetchImpl` is injectable for tests.
 */
export async function callChatCompletion(
  settings: LlmSettings,
  messages: ChatMessage[],
  fetchImpl?: typeof fetch,
): Promise<string> {
  const doFetch = fetchImpl ?? fetch;
  const base = settings.llmBaseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.llmApiKey) {
    headers["Authorization"] = `Bearer ${settings.llmApiKey}`;
  }
  const res = await doFetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.llmModel,
      messages,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed: HTTP ${res.status} ${body}`.trim());
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

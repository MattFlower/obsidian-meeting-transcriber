import { spawn } from "node:child_process";

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

/**
 * Build a single-string prompt for backends with no system/user message split
 * (e.g. a CLI): the same strict-JSON instructions as buildSummarizePrompt,
 * followed by the transcript. Pure so it can be tested.
 */
export function buildCliPrompt(transcript: string): string {
  const [system, user] = buildSummarizePrompt(transcript);
  return `${system.content}\n\n${user.content}`;
}

/**
 * Minimal structural shape of the child process used by runCliPrompt, so
 * tests can inject a fake without the real node:child_process instance.
 */
export interface CliChildProcess {
  stdout: CliChildStream | null;
  stderr: CliChildStream | null;
  write(data: string): void | boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CliChildStream {
  on(event: "data", listener: (chunk: string) => void): unknown;
}

export type SpawnImpl = (file: string, args: string[]) => CliChildProcess;

/** How long a CLI summarizer may run before it is killed (3 minutes). */
export const CLI_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Run a local CLI summarizer: split `command` on whitespace into argv (no
 * shell, so no injection), write `prompt` to stdin, and resolve with the
 * trimmed stdout on exit code 0. Rejects with a useful Error on a non-zero
 * exit (stderr tail included), on ENOENT ("command not found"), or after a
 * 3-minute timeout (the child is killed). `spawnImpl` is injectable for
 * tests.
 */
export async function runCliPrompt(
  command: string,
  prompt: string,
  spawnImpl?: SpawnImpl,
): Promise<string> {
  const argv = command.trim().split(/\s+/);
  if (argv.length === 0 || !argv[0]) {
    throw new Error("CLI command is empty; set it in the plugin settings.");
  }
  const doSpawn: SpawnImpl =
    spawnImpl ??
    ((file, args) => spawn(file, args) as unknown as CliChildProcess);
  const child = doSpawn(argv[0], argv.slice(1));

  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(new Error(`CLI command timed out after 3 minutes: ${command}`)),
      );
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle(
          () =>
            reject(
              new Error(
                `command not found: \`${argv[0]}\` — install it or change ` +
                  "the CLI command in settings",
              ),
            ),
        );
      } else {
        settle(() => reject(err));
      }
    });
    child.on("close", (code: number) => {
      if (code === 0) {
        settle(() => resolve(stdout.trim()));
      } else {
        const tail = stderr
          .trim()
          .split("\n")
          .slice(-5)
          .join(" | ");
        const suffix = tail ? `: ${tail}` : "";
        settle(() =>
          reject(new Error(`CLI command exited with code ${code}${suffix}`)),
        );
      }
    });

    child.write(prompt);
  });
}

/**
 * The summarizer-relevant subset of plugin settings (structurally satisfied
 * by TranscriberSettings).
 */
export interface SummarizerSettings {
  summarizerBackend: "cloud" | "local" | "cli";
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  localBaseUrl: string;
  localModel: string;
  cliCommand: string;
}

/** Injectable dependencies for summarizeTranscript (tests). */
export interface SummarizerDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnImpl;
}

/**
 * Summarize a transcript using the backend chosen in settings:
 *  - "cloud" → the user's OpenAI-compatible HTTP API with their API key
 *  - "local" → an OpenAI-compatible HTTP server on this machine (no key)
 *  - "cli"   → a local CLI subprocess using its own login (no key stored)
 * Returns the parsed SummaryResult.
 */
export async function summarizeTranscript(
  settings: SummarizerSettings,
  transcript: string,
  deps?: SummarizerDeps,
): Promise<SummaryResult> {
  let raw: string;
  if (settings.summarizerBackend === "cli") {
    raw = await runCliPrompt(
      settings.cliCommand,
      buildCliPrompt(transcript),
      deps?.spawnImpl,
    );
  } else {
    const llm =
      settings.summarizerBackend === "local"
        ? {
            llmBaseUrl: settings.localBaseUrl,
            llmApiKey: "",
            llmModel: settings.localModel,
          }
        : {
            llmBaseUrl: settings.llmBaseUrl,
            llmApiKey: settings.llmApiKey,
            llmModel: settings.llmModel,
          };
    raw = await callChatCompletion(
      llm,
      buildSummarizePrompt(transcript),
      deps?.fetchImpl,
    );
  }
  return parseSummaryResponse(raw);
}

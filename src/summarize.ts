import { spawn } from "node:child_process";
import { homedir } from "node:os";

import {
  callChatCompletion,
  type ChatMessage,
  type LlmSettings,
} from "./chat-completion";

// The HTTP client moved to chat-completion.ts (shared with the S1-mini
// normalizer); re-exported so existing callers and tests keep importing it
// from here.
export { callChatCompletion };
export type { ChatMessage, LlmSettings };

export interface SummaryResult {
  summary: string;
  description: string;
  tags: string[];
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
 * Build a single-string prompt for backends with no system/user message split
 * (e.g. a CLI): the same strict-JSON instructions as buildSummarizePrompt,
 * followed by the transcript. Pure so it can be tested.
 */
export function buildCliPrompt(transcript: string): string {
  const [system, user] = buildSummarizePrompt(transcript);
  return `${system.content}\n\n${user.content}`;
}

/**
 * Minimal structural shape of the child process used by runCliPrompt. It is
 * the subset of Node's ChildProcess that is actually used, including the
 * `stdin` stream the prompt is written to, so a fake in tests has the same
 * shape as the real object. (An earlier fake carried a `write` method the
 * real process lacks, which hid a bug that broke this backend outright.)
 */
export interface CliChildStream {
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
}

export interface CliChildStdin {
  write(data: string): boolean;
  end(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface CliChildProcess {
  stdin: CliChildStdin | null;
  stdout: CliChildStream | null;
  stderr: CliChildStream | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnImpl = (file: string, args: string[]) => CliChildProcess;

/** How long a CLI summarizer may run before it is killed (3 minutes). */
export const CLI_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Split a command line into argv without a shell: whitespace separates
 * arguments, and single or double quotes group text that contains spaces
 * (an absolute path such as `"/Applications/My Tools/claude" -p`). Quotes
 * are removed; there is no escaping or variable expansion. Pure so it can
 * be tested.
 */
export function splitCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) argv.push(current);
      current = "";
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) argv.push(current);
  return argv;
}

/**
 * Directories where user-installed CLIs commonly live but that a desktop-
 * launched Obsidian does not have on PATH: on macOS the app is a child of
 * launchd, not of a login shell, so it inherits /usr/bin:/bin:/usr/sbin:/sbin
 * and never sees Homebrew, npm-global, or ~/.local installs. They are
 * appended after the inherited PATH, so anything already found there still
 * wins. Windows GUI apps inherit the user's PATH, so it is returned as is.
 * Pure so it can be tested.
 */
export function extendedPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const inherited = env.PATH ?? env.Path ?? "";
  if (platform === "win32") return inherited;
  const parts = inherited.split(":").filter((p) => p.length > 0);
  const seen = new Set(parts);
  for (const dir of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/bin`,
  ]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(":");
}

/**
 * Run a local CLI summarizer: split `command` into argv (no shell, so no
 * injection), write `prompt` to the child's stdin and close it, and resolve
 * with the trimmed stdout on exit code 0. Rejects with a useful Error on a
 * non-zero exit (stderr tail included), on ENOENT ("command not found"), or
 * after `timeoutMs` (the child is killed). `spawnImpl` is injectable for
 * tests.
 *
 * Obsidian is launched from the desktop, so the child would inherit a
 * minimal PATH; the spawn extends it with the usual user-install directories
 * (see extendedPath), and the settings UI suggests an absolute path if the
 * CLI still is not found.
 */
export async function runCliPrompt(
  command: string,
  prompt: string,
  spawnImpl?: SpawnImpl,
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<string> {
  const argv = splitCommand(command);
  if (argv.length === 0 || argv[0] === "") {
    throw new Error("CLI command is empty; set it in the plugin settings.");
  }
  const doSpawn: SpawnImpl =
    spawnImpl ??
    ((file, args) =>
      spawn(file, args, {
        env: { ...process.env, PATH: extendedPath(process.env) },
      }));
  const child = doSpawn(argv[0], argv.slice(1));

  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdinError: Error | null = null;
    const stdinNote = () =>
      stdinError ? ` (stdin error: ${stdinError.message})` : "";
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Every settle() call site runs after this assignment: the listeners
    // below fire asynchronously, and the synchronous !stdin branch is later.
    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(
          new Error(
            `CLI command timed out after ${Math.ceil(timeoutMs / 1000)} s: ` +
              command +
              stdinNote(),
          ),
        ),
      );
    }, timeoutMs);

    // Decode as UTF-8 at the stream so a multi-byte character split across
    // two chunks is not corrupted by string concatenation.
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle(() =>
          reject(
            new Error(
              `command not found: \`${argv[0]}\`. Install it, or set an ` +
                "absolute path to it as the CLI command in settings.",
            ),
          ),
        );
      } else {
        settle(() => reject(err));
      }
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        settle(() => resolve(stdout.trim()));
        return;
      }
      const tail = stderr.trim().split("\n").slice(-5).join(" | ");
      const suffix = tail ? `: ${tail}` : "";
      const how =
        code === null
          ? `was killed by ${signal ?? "a signal"}`
          : `exited with code ${code}`;
      settle(() =>
        reject(new Error(`CLI command ${how}${suffix}${stdinNote()}`)),
      );
    });

    // Feed the prompt and close stdin so the CLI sees end-of-input; without
    // the close, `claude -p` waits for more input until the timeout. A CLI
    // that exits before reading everything raises EPIPE on stdin; a listener
    // is required so it cannot surface as an unhandled stream error. The
    // error is kept, not dropped: the close handler reports the exit code,
    // and a timeout or failure message carries the stdin error with it.
    const stdin = child.stdin;
    if (!stdin) {
      child.kill();
      settle(() =>
        reject(new Error("CLI child process exposes no stdin for the prompt.")),
      );
      return;
    }
    stdin.on("error", (err) => {
      stdinError = err;
    });
    stdin.write(prompt);
    stdin.end();
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

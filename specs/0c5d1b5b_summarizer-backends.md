# Plan: Selectable summarization backends (cloud / local / CLI)

Date: 2026-08-24

## Goal

Let the user pick one of three summarization backends in plugin settings and
have the "Summarize and tag this transcription" command use it, writing the
result as a `## Summary` section at the **top of the note body** (immediately
after the H1 title, above `## Transcript`):

1. **cloud** — an OpenAI-compatible HTTP API with the user's API key
   (existing behavior).
2. **local** — a local LLM server on the user's machine (Ollama / LM Studio),
   OpenAI-compatible HTTP, no API key required.
3. **cli** — a local CLI subprocess (`claude -p` by default; the OpenAI
   equivalent is `codex exec`) that uses the CLI's own already-configured
   auth. The plugin stores no key for this backend.

## Current state (what already exists)

- `src/summarize.ts` — `buildSummarizePrompt`, `callChatCompletion`
  (OpenAI-compatible `/chat/completions`, key optional), `parseSummaryResponse`,
  `sanitizeTags`. All pure/injectable and unit-tested in `tests/summarize.test.ts`.
- `src/note.ts` — `insertSummarySection` (replaces an existing `## Summary`,
  otherwise inserts before `## Transcript`), `applySummaryToBody`,
  `mergeSummaryIntoFrontmatter`. Tested in `tests/note.test.ts`.
- `src/main.ts` — `summarizeActiveOrSuggested` / `summarizeFile` already wire
  the command to `callChatCompletion` and write the note; guard currently
  requires an API key unless the base URL is local (`isLocalBaseUrl`).
- `src/settings.ts` — `llmBaseUrl`, `llmApiKey`, `llmModel` settings + tab.
- Build: `npm run build` (tsc typecheck + esbuild; node builtins are external,
  so `node:child_process` is fine). Tests: `npm test` (vitest run).

## Changes

### 1. `src/settings.ts` — backend selector + per-backend fields

Extend `TranscriberSettings`:

```ts
export type SummarizerBackend = "cloud" | "local" | "cli";

// new fields
summarizerBackend: SummarizerBackend;   // default "cloud" (existing users unchanged)
localBaseUrl: string;                   // default "http://localhost:11434/v1"
localModel: string;                     // default "llama3.1"
cliCommand: string;                     // default "claude -p"
```

Keep existing `llmBaseUrl` / `llmApiKey` / `llmModel` as the **cloud**
backend's fields (update their setting descriptions to say "Cloud backend").

Settings tab (`TranscriberSettingTab.display`):
- Add a "Summarization backend" dropdown at the top of the LLM section with
  options: `cloud` → "Cloud LLM (HTTP API + key)", `local` → "Local LLM
  (on this machine)", `cli` → "Local CLI (claude -p / codex exec)".
  On change: save, then `this.display()` to re-render so only the relevant
  fields show.
- cloud: existing base URL / API key / model fields.
- local: `localBaseUrl` + `localModel` text fields (desc: Ollama
  `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`; no key
  needed).
- cli: `cliCommand` text field. Desc: "Command that reads a prompt on stdin
  and prints the answer, e.g. `claude -p` or `codex exec`. Uses the CLI's own
  login — no API key is stored by the plugin."

### 2. `src/summarize.ts` — CLI runner + backend dispatcher

Add, keeping everything pure/injectable like the existing code:

- `buildCliPrompt(transcript: string): string` — single-string version of
  `buildSummarizePrompt`: the same strict-JSON instructions
  (`{"summary", "description", "tags"}`) followed by the transcript, for
  backends with no system/user message split.
- `runCliPrompt(command: string, prompt: string, spawnImpl?): Promise<string>`
  - Split `command` on whitespace into argv (no shell — avoids injection).
  - Spawn via `node:child_process` `spawn` (injectable for tests), write
    `prompt` to stdin, collect stdout/stderr.
  - Resolve with trimmed stdout on exit code 0; reject with a useful Error on
    non-zero exit (include stderr tail), on `ENOENT` ("command not found:
    `<cmd>` — install it or change the CLI command in settings"), and on a
    timeout (3 minutes, kill the child).
- `summarizeTranscript(settings, transcript, deps?): Promise<SummaryResult>`
  — the dispatcher:
  - Build messages/prompt once; on backend:
    - `"cloud"` → `callChatCompletion({llmBaseUrl, llmApiKey, llmModel}, …)`.
    - `"local"` → `callChatCompletion({llmBaseUrl: localBaseUrl, llmApiKey: "", llmModel: localModel}, …)`.
    - `"cli"` → `runCliPrompt(cliCommand, buildCliPrompt(transcript))`.
  - Pass the raw text through the existing `parseSummaryResponse` and return
    the `SummaryResult`. `deps` allows injecting `fetchImpl`/`spawnImpl`.

### 3. `src/main.ts` — use the dispatcher, backend-aware guard

In `summarizeFile`:
- Replace the API-key/`isLocalBaseUrl` guard with per-backend validation:
  - cloud: require `llmApiKey` (Notice: "Set the cloud LLM API key in
    settings, or switch the summarization backend.").
  - local: require non-empty `localBaseUrl` and `localModel`.
  - cli: require non-empty `cliCommand`.
- Replace the `buildSummarizePrompt` + `callChatCompletion` +
  `parseSummaryResponse` sequence with one call to
  `summarizeTranscript(this.settings, transcript)`.
- Note-writing stays exactly as-is (`applySummaryToBody` +
  `processFrontMatter` + `mergeSummaryIntoFrontmatter`).
- Delete `isLocalBaseUrl` if it becomes unused.
- Update the plugin header comment to mention the three backends.

### 4. `src/note.ts` — summary lands at the TOP of the body

Today a new `## Summary` is inserted immediately before `## Transcript`. For
the plugin's own notes (H1 + Transcript only) that already coincides with
"top", but make it literal for any meeting note:

- In `insertSummarySection`, when there is **no** existing `## Summary`:
  insert the new section at the top of the body — after the leading `# ` H1
  line (and its following blank line) if one is present, otherwise at the very
  start of the body — instead of before `## Transcript`.
- Replacing an existing `## Summary` in place is unchanged.
- `applySummaryToBody` / `applySummary` need no signature changes.

### 5. Tests

`tests/note.test.ts`:
- Update the `insertSummarySection` "no Transcript heading" test: the section
  now goes at the top of the body, not appended at the end.
- New test: on a plugin-style note (frontmatter + `# Title` + `## Transcript`
  + extra trailing section), `applySummaryToBody` produces a body whose
  **first `##` heading is `## Summary`**, positioned after the H1 and before
  `## Transcript` (assert via indexOf ordering and a
  `body.split("\n").find(l => l.startsWith("## "))` check).
- Keep the existing replace-in-place tests passing.

`tests/summarize.test.ts`:
- `buildCliPrompt`: contains the JSON-shape instructions and the transcript.
- `runCliPrompt` with a fake `spawnImpl`:
  - resolves with stdout on exit 0 (and the prompt was written to stdin);
  - rejects on non-zero exit with stderr in the message;
  - rejects with a "command not found" error on `ENOENT`.
- `summarizeTranscript` dispatcher:
  - `cloud` uses `llmBaseUrl`/`llmApiKey`/`llmModel` (fake fetch asserts URL +
    Authorization header);
  - `local` uses `localBaseUrl`/`localModel` and sends **no** Authorization
    header;
  - `cli` calls the fake spawn and parses its stdout through
    `parseSummaryResponse` (return fenced JSON from the fake to prove the
    parse path);
  - switching `summarizerBackend` changes which dependency is invoked (assert
    the other fake was never called).

## Out of scope

- No changes to the transcription pipeline (`audio.ts`, `transcriber.ts`,
  `live.ts`, `live-panel.ts`).
- No summarizing of non-meeting notes, no automatic re-summarization on
  transcript updates, no UI beyond the settings dropdown/fields and the
  existing command.

## Verification

1. `npm test` — all vitest suites pass, including the new backend and
   summary-placement tests.
2. `npm run build` — `tsc -noEmit -skipLibCheck` typechecks and esbuild
   bundles cleanly.
3. Manual smoke (optional, documented in the PR): pick each backend in
   settings, run "Summarize and tag this transcription" on a meeting note,
   confirm the `## Summary` section appears as the first section of the note
   body above `## Transcript`, and that switching the backend switches which
   one runs (e.g. CLI backend works with an empty API key).

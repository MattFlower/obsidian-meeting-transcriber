# Plan: Obsidian meeting transcriber plugin (Parakeet ASR + AI summarization)

Date: 2026-08-18

## Goal

Greenfield Obsidian plugin (TypeScript) at the repo root that:

1. Transcribes an audio file already in the vault into a new note, using **Parakeet**
   (NVIDIA Parakeet TDT 0.6B v2, int8 ONNX) running **locally** via the
   `sherpa-onnx-node` npm package (verified on npm: v1.13.6, published by k2-fsa,
   supports NeMo Parakeet TDT offline transducer models).
2. Offers a separate **summarize** command that calls an OpenAI-compatible chat
   endpoint (configurable base URL / API key / model) to add `tags` and a
   `description` to the transcription note's frontmatter plus a `## Summary`
   section, so the note is easy to search later.

## Explicitly out of scope

- Live / real-time recording (input is an audio file already in the vault).
- Speaker diarization.
- Cloud transcription services (transcription is fully local; only the
  *summarization* step calls an LLM API).
- Community plugin registry submission.
- The existing Rust crate (`Cargo.toml`, `src/main.rs`) — leave in place, untouched.
- Do not modify `adws/` or `.claude/`.

## Architecture decisions (grounded)

- **ASR engine:** `sherpa-onnx-node` (native Node addon, ships platform prebuilds).
  Obsidian desktop is Electron with Node integration enabled in the renderer, and
  Electron uses the same `NODE_MODULE_VERSION` as its bundled Node, so the
  Node prebuilds load. It must be listed as an esbuild **external** and loaded
  via `require('sherpa-onnx-node')` at runtime, never bundled.
  - Fallback if a user's Electron/Node ABI rejects the prebuild: spawn
    `process.execPath` with `ELECTRON_RUN_AS_NODE=1` running a small helper
    script that does the transcription. Implement this only as a code comment /
    documented note, not required for "done".
- **Model files:** NeMo Parakeet TDT 0.6B v2 int8 from HuggingFace
  `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`
  (files: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`).
  A plugin command "Download Parakeet model" fetches these via
  `https://huggingface.co/<repo>/resolve/main/<file>` into
  `<vault>/.obsidian/plugins/obsidian-meeting-transcriber/models/parakeet/`
  (configurable model dir in settings).
- **Audio decoding:** Obsidian's renderer has Web Audio. Use
  `AudioContext.decodeAudioData` on the file's ArrayBuffer, resample to 16 kHz
  mono `Float32Array` via `OfflineAudioContext`. Supports wav/mp3/m4a/flac/ogg.
- **Summarization LLM:** plain `fetch` against an OpenAI-compatible
  `/chat/completions` endpoint (settings: base URL default
  `https://api.openai.com/v1`, API key, model, e.g. `gpt-4o-mini`; works with
  local servers like Ollama/LM Studio too). Ask for strict JSON
  `{ "summary": string, "description": string, "tags": string[] }`.
- **Testing:** `vitest` (node environment). All testable logic lives in plain
  TS modules that do NOT import `obsidian` (or receive its types via
  interfaces), so `npm test` runs headless without an Obsidian instance.
  `obsidian` is a devDependency only (types + esbuild external).
- **Build:** standard Obsidian sample-plugin esbuild setup. `npm run build`
  typechecks (`tsc -noEmit`) and bundles `src/main.ts` → `main.js` at repo root.

## Files to create

### Root config

- `package.json` — name `obsidian-meeting-transcriber`, scripts:
  - `"build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production"`
  - `"dev": "node esbuild.config.mjs"`
  - `"test": "vitest run"`
  - deps: `sherpa-onnx-node` (pin `^1.13.6`)
  - devDeps: `typescript`, `esbuild`, `obsidian` (latest), `vitest`,
    `@types/node`, `builtin-modules`, `tslib`.
- `manifest.json` — id `obsidian-meeting-transcriber`, name "Meeting Transcriber",
  version `0.1.0`, `minAppVersion: "1.4.0"`, `isDesktopOnly: true`
  (native addon + Web Audio decoding).
- `versions.json` — `{ "0.1.0": "1.4.0" }`.
- `tsconfig.json` — standard Obsidian sample config (`module: ESNext`,
  `target: ES2018`, `moduleResolution: node`, `strict`, `lib` includes DOM +
  ES2020 for Web Audio types).
- `esbuild.config.mjs` — copy of the obsidian-sample-plugin esbuild config:
  entry `src/main.ts`, bundle, `format: cjs`, `target: es2018`, outfile
  `main.js`, externals: `obsidian`, `electron`, all node builtins
  (`builtin-modules`), and `sherpa-onnx-node`. Banner `/* generated */`.
  Dev mode = watch; production mode = single build.
- `vitest.config.ts` — node environment, include `tests/**/*.test.ts`.
- `README.md` — short: features, model download step, settings, dev/build/test.
- `.gitignore` — append `node_modules/`, `main.js`, `*.onnx`, `models/` (keep
  existing Rust entries).

### Source (`src/`)

- `src/main.ts` — `MeetingTranscriberPlugin extends Plugin` (thin wiring only,
  not unit-tested):
  - `onload`: load settings, add settings tab, register commands:
    1. `transcribe-audio-file` — "Transcribe meeting audio to note": suggest
       modal listing vault files with audio extensions
       (`.mp3 .wav .m4a .flac .ogg .aac .opus`); on pick, decode → transcribe →
       create note; progress via `Notice` and a status-bar item.
    2. `download-parakeet-model` — download the 4 model files with progress
       notices.
    3. `summarize-transcription` — "Summarize and tag this transcription":
       runs on the active note (or suggest modal over notes in the transcription
       folder); calls LLM; updates frontmatter + inserts summary section.
  - Guards: model files present before transcribing (else notice pointing at the
    download command); API key set before summarizing.
- `src/settings.ts` — `TranscriberSettings` interface + `DEFAULT_SETTINGS` +
  `TranscriberSettingTab` (model dir, transcription output folder (default
  `Meetings/`), LLM base URL, API key, model name, default tags).
- `src/audio.ts` — pure-ish helpers: `AUDIO_EXTENSIONS`, `isAudioFile(path)`,
  `decodeToMono16k(arrayBuffer, ctxFactory)` (uses `OfflineAudioContext` for
  resampling; takes the context factory as a param so tests can inject a stub).
- `src/transcriber.ts` — wraps `sherpa-onnx-node`: `buildRecognizerConfig(modelDir)`
  (pure, unit-tested — verifies file names/paths, offline transducer config with
  `modelType: "nemo_transducer"`... confirm exact key from sherpa-onnx docs:
  `offlineTransducer: { encoder, decoder, joiner }`, `tokens`, `numThreads`),
  `transcribeFile(pcm: Float32Array, modelDir)` (thin, loads recognizer,
  `OfflineStream`, returns text; not unit-tested).
- `src/model-download.ts` — `MODEL_FILES` list, `modelFileUrls(repoId)` (pure,
  tested), `downloadModel(destDir, onProgress)` using `fetch` + streaming write
  via `node:fs` (thin).
- `src/summarize.ts` — pure: `buildSummarizePrompt(transcript)` (system+user
  messages requesting JSON), `parseSummaryResponse(text)` (tolerant JSON
  extraction: strip ```json fences, validate shape, sanitize tags to
  Obsidian-legal `[a-z0-9/_-]` kebab form, dedupe, cap at 8) — both unit-tested.
  `callChatCompletion(settings, messages)` via `fetch` (thin; testable by
  injecting fetch).
- `src/note.ts` — pure note-content logic, unit-tested:
  - `transcriptionNoteContent({title, date, audioLink, transcript, tags})` →
    markdown with YAML frontmatter (`tags`, `description` placeholder,
    `source: "[[audio file]]"`, `date`) + `# <title>` + `## Transcript`.
  - `applySummary(markdown, {summary, description, tags})` → markdown with
    frontmatter tags merged (union, existing preserved), `description` set, and
    a `## Summary` section inserted before `## Transcript` (replace if present).
  - `noteFileName(date, audioBaseName)` → `YYYY-MM-DD HHmm <name>.md`
    (filesystem-safe).
  - Frontmatter handling: hand-rolled minimal YAML emit/parse for the known
    small field set (avoids a YAML dependency); plugin-side updates go through
    Obsidian's `app.fileManager.processFrontMatter` where possible.

### Tests (`tests/`)

- `tests/audio.test.ts` — extension filtering.
- `tests/transcriber.test.ts` — `buildRecognizerConfig` path/file correctness,
  error when a model file is missing.
- `tests/model-download.test.ts` — URL construction, file list completeness.
- `tests/summarize.test.ts` — prompt contains instruction to return JSON;
  `parseSummaryResponse` on: clean JSON, fenced JSON, JSON with trailing prose,
  bad tags (spaces, uppercase, dupes → sanitized/deduped), malformed input →
  throws with useful message.
- `tests/note.test.ts` — frontmatter emitted correctly; `applySummary` merges
  tags without clobbering existing ones, sets description, inserts/replaces
  `## Summary` before `## Transcript`; filename sanitization.

## Manual verification (document in README, builder runs what it can)

1. `npm install && npm run build` → `main.js` at root, no type errors.
2. `npm test` → all vitest suites pass.
3. Copy repo (or symlink) into `<vault>/.obsidian/plugins/obsidian-meeting-transcriber/`
   with `manifest.json` + `main.js`; enable in Obsidian; run "Download Parakeet
   model"; drop a short audio file in the vault; run "Transcribe meeting audio
   to note"; confirm note created with transcript; run "Summarize and tag this
   transcription"; confirm tags/description/summary appear.
4. `git status` must show no changes under `adws/`, `.claude/`, `Cargo.toml`,
   `src/main.rs`.

## Done criteria mapping

- `npm run build` produces the bundle → esbuild config + tsc gate.
- `npm test` passes → vitest suites above.
- Plugin loads in a vault → manifest.json + main.js + isDesktopOnly.
- Command transcribes vault audio via Parakeet → sherpa-onnx-node + decode + note.
- Separate summarize option adds tags + description → summarize command +
  frontmatter update.

## Risks / notes for the builder

- **ABI:** if `require('sherpa-onnx-node')` throws an ABI error inside Obsidian,
  note the `ELECTRON_RUN_AS_NODE=1` child-process fallback in the README (do not
  build it unless trivial).
- sherpa-onnx-node's exact offline-recognizer config key names
  (`offlineTransducer` vs `transducer`) should be checked against the installed
  package's `non-streaming-asr.js` examples; keep `buildRecognizerConfig`
  isolated so this is a one-function fix.
- int8 Parakeet model files are large (~600 MB total); the download command
  needs a progress notice and a resume-free simple fetch is acceptable.
- Never commit the model files or `main.js`; keep API keys out of any committed
  file (settings live in the vault's `data.json`).

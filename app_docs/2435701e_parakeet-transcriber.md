# Meeting Transcriber Obsidian plugin

## What changed

This greenfield TypeScript plugin adds desktop Obsidian commands for local meeting transcription and a separate AI-assisted organization step:

- **Transcribe meeting audio to note** lists vault audio files (`mp3`, `wav`, `m4a`, `flac`, `ogg`, `aac`, and `opus`), decodes and resamples the selected file to mono 16 kHz, then runs NVIDIA Parakeet TDT 0.6B v2 int8 ONNX through the native `sherpa-onnx-node` addon. It creates a note in the configured output folder (default `Meetings/`) with `tags`, an empty `description`, source link, date, title, and `## Transcript` content.
- **Download Parakeet model** streams the four required model files from the configured Hugging Face repository into the vault-relative model directory (default `models/parakeet`) and reports progress.
- **Summarize and tag this transcription** operates on the active Markdown note or offers notes from the output folder. It sends the transcript to an OpenAI-compatible `/chat/completions` endpoint, parses the requested JSON result, inserts or replaces `## Summary`, merges generated tags with existing tags, and sets the frontmatter description. Local endpoints can omit the API key.

The plugin is desktop-only because audio decoding uses Web Audio and ASR uses a native addon. The native addon remains external to the bundle and is copied into an installable package with its platform-specific binary.

## Where it lives

- `src/main.ts` wires Obsidian lifecycle, commands, notices/status bar, vault file selection, model checks/downloads, note creation, and summarization.
- `src/audio.ts` contains supported-extension filtering and injected Web Audio decode/resample helpers.
- `src/transcriber.ts` defines Parakeet model paths/configuration and lazy native recognizer invocation.
- `src/model-download.ts` defines the Hugging Face model files/URLs and streamed download progress.
- `src/note.ts` handles the small frontmatter format, note naming/sanitization, transcript note generation, and summary insertion/tag merging.
- `src/summarize.ts` builds the structured prompt, calls the OpenAI-compatible endpoint, and validates/sanitizes the response.
- `src/settings.ts` provides model/output/LLM/default-tag settings and the settings tab.
- `manifest.json`, `versions.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, and `esbuild.config.mjs` establish the Obsidian package metadata, dependencies, typecheck, tests, and bundle.
- `package.mjs` assembles `dist/obsidian-meeting-transcriber/` with `main.js`, metadata, README, `package.json`, and `sherpa-onnx-node` plus the matching native package.
- `tests/audio.test.ts`, `tests/model-download.test.ts`, `tests/transcriber.test.ts`, `tests/note.test.ts`, and `tests/summarize.test.ts` cover the pure helpers, streamed downloads, frontmatter behavior, and injectable HTTP paths.
- `README.md` documents setup, settings, packaging, installation, and limitations. `.gitignore` excludes `main.js`, model files, and `models/`.

## Use and verification

1. Run `npm install`.
2. Run `npm run package` to build and assemble the self-contained plugin folder. Copy its **contents** into `<vault>/.obsidian/plugins/obsidian-meeting-transcriber/`, then enable the plugin.
3. In Obsidian, run **Download Parakeet model** once. Configure the LLM base URL, optional API key, model, output folder, model directory, and default tags in plugin settings.
4. Run **Transcribe meeting audio to note**, choose an audio file in the vault, and inspect the generated note. Then run **Summarize and tag this transcription** and verify the summary section, merged tags, and description.
5. `npm test` runs the headless Vitest suite; verified in this change with 5 suites and 57 tests passing. `npm run build` typechecks and produces the root `main.js` bundle; it was also run successfully here. Build uses `npm run build` directly, while `npm run package` includes the native runtime dependency needed by Obsidian.

Generated `main.js`, native/model artifacts, and the LLM key stored by Obsidian are not intended as repository source files; the key is held in the vault plugin data.

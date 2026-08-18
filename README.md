# Meeting Transcriber (Obsidian plugin)

Transcribe meeting audio files that are already in your vault into Obsidian
notes, using **Parakeet** (NVIDIA Parakeet TDT 0.6B v2, int8 ONNX) running
**locally** via [`sherpa-onnx-node`](https://www.npmjs.com/package/sherpa-onnx-node).
A separate command then **summarizes** a transcription note with an
OpenAI-compatible LLM, adding `tags` and a `description` to the frontmatter
plus a `## Summary` section so the note is easy to search later.

- No cloud transcription: ASR runs entirely on your machine.
- Only the *summarize* step calls an LLM API (any OpenAI-compatible endpoint:
  OpenAI, Ollama, LM Studio, …).
- Desktop only (native addon + Web Audio decoding).

## Commands

- **Meeting Transcriber: Transcribe meeting audio to note** — pick an audio
  file in the vault (mp3, wav, m4a, flac, ogg, aac, opus); a note is created
  in the output folder (default `Meetings/`) with frontmatter
  (`tags`, `description`, `source`, `date`) and a `## Transcript` section.
- **Meeting Transcriber: Download Parakeet model** — fetches
  `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`
  from Hugging Face
  (`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`, ~600 MB) into the
  configured model directory.
- **Meeting Transcriber: Summarize and tag this transcription** — run on the
  active note (or pick one from the output folder); calls the LLM and updates
  the note's frontmatter (`tags` merged, `description` set) and inserts or
  replaces the `## Summary` section.

## Setup

1. Enable the plugin in a desktop vault.
2. Run **Download Parakeet model** (one-time, ~600 MB).
3. For summarization, set the LLM **base URL**, **API key** (leave empty for
   local servers such as Ollama), and **model** in the plugin settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Model directory | `models/parakeet` | Vault-relative folder with the ONNX model files |
| Transcription output folder | `Meetings` | Where transcription notes are created |
| LLM base URL | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| LLM API key | *(empty)* | Bearer token; empty for local servers |
| LLM model | `gpt-4o-mini` | Model name sent to the endpoint |
| Default tags | `meeting` | Comma-separated tags for new notes |

## Development

```sh
npm install
npm run dev        # watch build
npm run build      # typecheck + production bundle -> main.js
npm run package    # build + assemble a self-contained plugin folder in dist/
npm test           # vitest (headless; no Obsidian needed)
```

## Installing into a vault

The plugin has a **runtime native dependency** — `sherpa-onnx-node` — that is
kept external to the `main.js` bundle. It must be present in the plugin folder
so `require("sherpa-onnx-node")` resolves at runtime inside Obsidian.

The easiest path is to let the build assemble a self-contained folder:

```sh
npm run package
```

This produces `dist/obsidian-meeting-transcriber/` containing `main.js`,
`manifest.json`, `versions.json`, `package.json`, and a copy of
`node_modules/sherpa-onnx-node` (including its native binary). Copy the
**contents** of that folder into
`<vault>/.obsidian/plugins/obsidian-meeting-transcriber/` and enable the
plugin.

> **Platform note:** the packaged native binary matches the platform it was
> built on. If you install on a different OS/architecture and the addon fails
> to load, open a terminal in the plugin folder and run `npm install` to fetch
> the matching prebuild, then restart Obsidian.

## Notes & limitations

- **Native addon ABI:** `sherpa-onnx-node` ships prebuilt native binaries for
  Node. Obsidian desktop (Electron) uses the same Node ABI, so the prebuilds
  load in the renderer. If a future Obsidian/Electron ABI rejects the
  prebuild, a fallback is to run the transcription in a child process:
  spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and a small helper
  script that performs the same decode.
- No live/real-time recording and no speaker diarization (out of scope).
- Transcription of long recordings is CPU-bound and can take several minutes;
  a status-bar indicator and notices track progress.
- Model files and `main.js` are git-ignored; the LLM API key lives only in
  the vault's `data.json`, never in the repo.

# Meeting Transcriber (Obsidian plugin)

Transcribe meeting audio into Obsidian notes, using **Parakeet** (NVIDIA
Parakeet TDT 0.6B v2, int8 ONNX) running **locally** via
[`sherpa-onnx-node`](https://www.npmjs.com/package/sherpa-onnx-node). Two
paths are supported: transcribing audio files that are already in your
vault, and **live recording** a meeting (microphone or system audio) with
the transcript appended to the note as you speak. A separate command then
**summarizes** a transcription note with an OpenAI-compatible LLM, adding
`tags` and a `description` to the frontmatter plus a `## Summary` section so
the note is easy to search later.

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
- **Meeting Transcriber: Transcribe live meeting (record audio)** — opens the
  live-recording modal (also available as the microphone ribbon icon): record
  microphone or system audio and have the transcript appended to a note in
  the output folder **as the meeting is spoken** (see *Live recording* below).

## Live recording

The **Transcribe live meeting** command (or the microphone ribbon icon) opens
a modal that runs a live recording session:

1. Pick the **audio source**: *Microphone* or *System audio*.
2. Pick the **input device** (defaults to *System default*; loopback devices
   for system audio are selected here — see below).
3. Press **Start recording**. A note named
   `YYYY-MM-DD HHmm Live recording (<source>).md` is created in the output
   folder immediately, with `source: live-<source>` in its frontmatter.
4. Audio is captured at 16 kHz mono and cut into chunks (default 15 s,
   configurable in settings). Each finished chunk is transcribed with the
   local Parakeet model and appended to the note's `## Transcript` section
   **while the meeting is still in progress** — chunks are transcribed
   serially, so text lands in the note roughly every chunk length.
5. **Pause** suspends capture (the OS recording indicator turns off; nothing
   is transcribed while paused) without ending the session; **Resume**
   continues the same session and the same note. **Stop recording** (or
   closing the modal) flushes the final partial chunk (when it is at least
   one second long) and ends the session. If no speech was detected at all,
   the note gets a `_No speech detected._` placeholder.

A status line in the modal and the Obsidian status bar show the elapsed
(unpaused) time and when a chunk is being transcribed.

Only **one live recording session can be active at a time** across the whole
plugin: opening the modal or pressing **Start recording** while another
session is still recording shows a notice and is refused. The restriction is
lifted as soon as that session is stopped.

### System audio capture

Capturing system audio is a **platform constraint**: Obsidian's Electron
host does not expose system output the way it exposes a microphone. The
plugin handles it honestly, per platform:

- **macOS** — install a loopback driver such as
  [BlackHole](https://existential.audio/blackhole/) (or use the built-in
  *Audio MIDI Setup* aggregate/loopback), route the app audio you want to
  capture into it, then select that loopback device in the modal's *Input
  device* dropdown. On macOS 13+ with screen-recording permission granted,
  screen sharing may also provide a system-audio track directly.
- **Windows** — select *Stereo Mix* or a virtual cable (e.g. VB-CABLE) as
  the input device, or use screen-share audio when your Windows build
  provides it via the share prompt.
- **Linux** — select a PulseAudio/PipeWire *monitor* source (e.g.
  `@monitor` of your sink) as the input device.

When *System audio* is selected and the platform cannot provide a system
audio track, the plugin shows a notice explaining the requirement and asks
you to select a loopback input device. **It never silently falls back to the
microphone.** The first microphone capture triggers the OS permission prompt.

## Setup

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
| Live recording source | `microphone` | Pre-selected source for the live-recording modal; system audio requires a loopback device on most platforms (see *System audio capture*) |
| Live chunk length (seconds) | `15` | How often live audio is transcribed and appended to the note (5–60) |

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
- No speaker diarization (out of scope). Live recording transcribes in
  ~15 s chunks with the offline (non-streaming) Parakeet model, so there is
  a short delay between speech and the text appearing in the note; words
  split across chunk boundaries may occasionally be duplicated at the seam.
- System audio capture depends on platform loopback facilities — see
  *System audio capture* above.
- Transcription of long recordings is CPU-bound and can take several minutes;
  a status-bar indicator and notices track progress.
- Model files and `main.js` are git-ignored; the LLM API key lives only in
  the vault's `data.json`, never in the repo.

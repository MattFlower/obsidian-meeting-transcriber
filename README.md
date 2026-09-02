# Meeting Transcriber (Obsidian plugin)

Transcribe meeting audio into Obsidian notes, using **Parakeet** (NVIDIA
Parakeet TDT 0.6B v2, int8 ONNX) running **locally** via
[`sherpa-onnx-node`](https://www.npmjs.com/package/sherpa-onnx-node). Two
paths are supported: transcribing audio files that are already in your
vault, and **live recording** a meeting (microphone or system audio) with
the transcript appended to the note as you speak. A separate command then
**summarizes** a transcription note with an OpenAI-compatible LLM, adding
`tags` and a `description` to the frontmatter plus a `## Summary` section so
the note is easy to search later. Optionally, transcripts are cleaned up with
**S1-mini by Superwhisper**, a small local text normalizer that turns raw
speech-to-text output into readable written English (see *Text
normalization* below).

- No cloud transcription: ASR runs entirely on your machine.
- Only the *summarize* step calls an LLM API (any OpenAI-compatible endpoint:
  OpenAI, Ollama, LM Studio, …).
- Optional transcript clean-up runs on a local model server (Ollama,
  llama-server, LM Studio); nothing leaves your machine.
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
- **Meeting Transcriber: Normalize transcript with S1-mini** — run on the
  active note (or pick one from the output folder); sends the `## Transcript`
  section through S1-mini by Superwhisper and replaces it with the cleaned
  text (see *Text normalization* below).
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

## Text normalization with S1-mini by Superwhisper

Parakeet writes what it heard, fillers and all. [S1-mini by
Superwhisper](https://huggingface.co/superwhisper/s1-mini) is a 0.6B text
normalizer built for exactly this post-processing step: it removes filled
pauses (`um`, `uh`), resolves false starts and self-corrections to the value
the speaker landed on, applies punctuation and capitalization, and writes
spoken numbers, dates, times, currency and email addresses in written form.
It is English only.

The plugin talks to S1-mini through a local OpenAI-compatible server, the
same way the *Local* summarization backend works, so nothing leaves your
machine and no new dependencies are bundled. When **Normalize transcripts
with S1-mini by Superwhisper** is enabled in settings, normalization runs:

- on every note created by **Transcribe meeting audio to note**, right after
  the raw note is written (toggle *Normalize transcribed audio files*);
- once over the whole transcript when a live recording session stops
  (toggle *Normalize live recordings when they stop*). Live chunks are never
  normalized individually while recording, because the seam de-duplication
  compares words across chunks;
- on demand with **Normalize transcript with S1-mini**, for any note with a
  `## Transcript` section.

In every case the `## Transcript` section is **replaced** with the normalized
text; the raw transcript is not kept (Obsidian's *File recovery* core plugin
still snapshots earlier versions). Long transcripts are sent in chunks of
about 500 words cut at sentence boundaries, and each chunk becomes a
paragraph in the note. If the server cannot be reached or returns nothing,
the raw transcript stays as it is and a notice says why.

### Server setup

The model is the quantized GGUF build, `s1-mini-q4_k_m.gguf` (462 MB), from
[superwhisper/s1-mini-GGUF](https://huggingface.co/superwhisper/s1-mini-GGUF);
Ollama and llama-server fetch it for you, LM Studio needs it downloaded.
Serve it with one of the following. Two things matter with any server:
thinking mode must be **off** (S1-mini was trained without it and returns a
blank reply otherwise) and decoding must be **greedy** (the plugin always
sends `temperature: 0`).

**Ollama** (the default settings). The repository ships a `Modelfile` at
its root that pulls the GGUF from Hugging Face and hard-codes the
thinking-off prompt format, so from the repository root:

```sh
ollama create s1-mini -f Modelfile
```

If `create` does not fetch the base model itself, pull it first with
`ollama pull hf.co/superwhisper/s1-mini-GGUF:Q4_K_M` and run `create`
again. Installed the plugin from a packaged folder rather than the
repository? Save this as `Modelfile` anywhere and run the same command
there:

```dockerfile
FROM hf.co/superwhisper/s1-mini-GGUF:Q4_K_M

SYSTEM """You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text."""

TEMPLATE """<|im_start|>system
{{ .System }}<|im_end|>
<|im_start|>user
{{ .Prompt }}<|im_end|>
<|im_start|>assistant
<think>

</think>

"""

PARAMETER temperature 0
PARAMETER num_ctx 4096
```

(`FROM ./s1-mini-q4_k_m.gguf` works too if you downloaded the file by
hand.) Server URL `http://localhost:11434/v1`, model name `s1-mini`.

**llama-server** (llama.cpp):

```sh
llama-server -hf superwhisper/s1-mini-GGUF:Q4_K_M --jinja \
  --chat-template-kwargs '{"enable_thinking":false}' --temp 0
```

Server URL `http://localhost:8080/v1`; llama-server ignores the model name,
so any value works.

**LM Studio.** Load `s1-mini-q4_k_m.gguf`, set the temperature to 0 and
disable the thinking/reasoning toggle, then start the local server with CORS
enabled. Server URL `http://localhost:1234/v1`, model name = the loaded
model's identifier.

To check a server before enabling the setting:

```sh
curl -s http://localhost:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "s1-mini",
  "messages": [
    {"role": "system", "content": "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text."},
    {"role": "user", "content": "[Styling: semi-formal] [Structure: prose] [Context: general]\nso um i need to like send the the report by uh friday no wait make that thursday"}
  ],
  "temperature": 0
}'
```

The reply should contain `I need to send the report by Thursday.`

### Styling and structure

**S1-mini styling** picks the register: `casual` (all lowercase, apostrophes
stripped), `semi-casual` (the speaker's phrasing, with `I` and its
contractions capitalized), `semi-formal` (standard written English,
contractions kept; the default) or `formal` (contractions expanded).
**S1-mini structure** is `prose` (sentences and paragraphs; the default) or
`lists`, which lets the model turn a clear enumeration of three or more items
into Markdown bullets. Fillers are removed in every register.

### Troubleshooting

- *"S1-mini returned no text for any chunk"*: thinking mode is still on in
  the server. Use the Modelfile above for Ollama, the `--jinja
  --chat-template-kwargs` flags for llama-server, or the thinking toggle in
  LM Studio.
- *HTTP 404*: the model name in settings does not match a model on the
  server (for Ollama, run `ollama create` first).
- *"Could not reach the S1-mini server"*: the server is not running, or the
  URL is wrong.
- *"N kept raw text"* in the completion notice: the reply for a chunk was
  empty or far longer or shorter than its input, so the raw text was kept
  for that chunk. Check the server and re-run the command.

### License

S1-mini is released under Apache 2.0, inherited from Qwen3-0.6B, plus one
extra term: wherever it is used it must keep its name, "S1-mini" by
"Superwhisper", with that exact capitalization. This plugin does not bundle
the weights; you download them from Hugging Face under that license. See the
model's [LICENSE](https://huggingface.co/superwhisper/s1-mini/blob/main/LICENSE)
and [NOTICE](https://huggingface.co/superwhisper/s1-mini/blob/main/NOTICE).

## Setup

1. Enable the plugin in a desktop vault.
2. Run **Download Parakeet model** (one-time, ~600 MB).
3. For summarization, pick a **Summarization backend** in the plugin
   settings: *Cloud* (base URL, API key, model), *Local* (an
   OpenAI-compatible server on this machine such as Ollama or LM Studio), or
   *Local CLI* (a command such as `claude -p` that reads the prompt on stdin
   and prints the answer; if it is not found, give an absolute path).
4. Optionally, serve S1-mini by Superwhisper on a local model server and
   enable **Normalize transcripts with S1-mini by Superwhisper** in the
   plugin settings (see *Text normalization* above).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Model directory | `models/parakeet` | Vault-relative folder with the ONNX model files |
| Transcription output folder | `Meetings` | Where transcription notes are created |
| Summarization backend | `cloud` | `cloud` (HTTP API + key), `local` (OpenAI-compatible server on this machine), or `cli` (a local CLI such as `claude -p`) |
| Cloud LLM base URL | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| Cloud LLM API key | *(empty)* | Bearer token for the cloud backend |
| Cloud LLM model | `gpt-4o-mini` | Model name sent to the endpoint |
| Local LLM base URL | `http://localhost:11434/v1` | Local OpenAI-compatible server (Ollama, LM Studio); no key needed |
| Local LLM model | `llama3.1` | Model name sent to the local server |
| CLI command | `claude -p` | Command that reads the prompt on stdin and prints the answer. Homebrew, `/usr/local/bin`, `~/.local/bin` and npm-global directories are searched; if the command is still not found, give an absolute path (quoted if it contains spaces) |
| Default tags | `meeting` | Comma-separated tags for new notes |
| Live recording source | `microphone` | Pre-selected source for the live-recording modal; system audio requires a loopback device on most platforms (see *System audio capture*) |
| Live chunk length (seconds) | `15` | How often live audio is transcribed and appended to the note (5–60) |
| Normalize transcripts with S1-mini by Superwhisper | off | Master switch for transcript normalization (see *Text normalization*) |
| S1-mini server URL | `http://localhost:11434/v1` | Local OpenAI-compatible server running S1-mini (Ollama, llama-server, LM Studio) |
| S1-mini API key | *(empty)* | Optional Bearer token; not needed for local servers |
| S1-mini model name | `s1-mini` | The name the server knows the model by |
| S1-mini styling | `semi-formal` | Output register: `casual`, `semi-casual`, `semi-formal` or `formal` |
| S1-mini structure | `prose` | `prose`, or `lists` to allow Markdown bullets for clear enumerations |
| Normalize transcribed audio files | on | Normalize each note created by the file transcription command (when the master switch is on) |
| Normalize live recordings when they stop | on | Normalize a live recording's note once the session ends (when the master switch is on) |

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
- Text normalization with S1-mini is English only, and it rewrites the
  transcript: fillers and self-corrections are dropped, so keep the audio if
  you need a verbatim record.
- Model files and `main.js` are git-ignored; the LLM API key lives only in
  the vault's `data.json`, never in the repo.

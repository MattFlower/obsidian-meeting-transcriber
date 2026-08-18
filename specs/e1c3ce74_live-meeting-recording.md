# Plan: Live meeting recording with pause and source selection

Date: 2026-08-18
Session: e1c3ce74

## Goal

Add an interactive control (a modal driven by a new command + ribbon icon) that
records live audio — microphone or system audio — transcribes it incrementally
with the existing local Parakeet model, and appends the transcript into an
Obsidian note **as the meeting is spoken**, with a pause/resume button that
suspends capture without ending the session.

Out of scope (do not touch): the existing file-based transcription flow's
behavior, the summarize/tagging feature, speaker diarization, cloud ASR,
community-registry submission, `adws/`, `.claude/`.

## Key design decisions

1. **Incremental = chunked offline decoding.** The bundled model
   (Parakeet TDT 0.6B v2) is a *non-streaming* transducer; sherpa-onnx-node's
   `OnlineRecognizer` requires a different (zipformer streaming) model, which is
   out of scope. Instead, capture PCM continuously and cut it into fixed-length
   chunks (default 15 s, configurable) that are transcribed sequentially with
   the existing `transcribe()` from `src/transcriber.ts`. Each finished chunk's
   text is appended to the note immediately, so text lands in the note during
   the meeting, not only at the end.

2. **Capture via Web Audio.** `navigator.mediaDevices.getUserMedia()` for the
   microphone, an `AudioContext` created with `sampleRate: 16000` (supported by
   Obsidian's Chromium) plus a `MediaStreamAudioSourceNode` →
   `ScriptProcessorNode` (deprecated but the only option that works without
   shipping a separate worklet file through esbuild) that hands mono
   `Float32Array` frames to a chunker. The PCM is already 16 kHz mono — exactly
   what `transcribe()` wants — so no resampling is needed.

3. **System audio is a platform constraint, surfaced honestly.** Obsidian's
   Electron does not install a `setDisplayMediaRequestHandler`, and Chromium
   cannot grab system output the way it grabs a mic. Behavior:
   - When **System audio** is selected, first attempt
     `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })` and
     use the audio track if one is returned (works on Windows full-screen
     share; macOS 13+ with screen-recording permission may also yield audio).
   - If that throws or yields no audio track, show a `Notice` explaining that
     the platform cannot expose system audio directly and that the user must
     select a **loopback device** from the input-device dropdown (e.g.
     BlackHole on macOS, Stereo Mix / VB-CABLE on Windows, a PulseAudio/PipeWire
     monitor source on Linux). **Never silently record the microphone instead.**
   - The modal therefore always shows an **input device dropdown** (populated
     from `navigator.mediaDevices.enumerateDevices()`, `kind === "audioinput"`,
     default "System default"); loopback devices appear there.
   - The same explanation goes into the settings tab (as a read-only
     description under the new live-recording settings) and the README.

4. **Pause.** A paused flag makes the audio callback drop incoming samples
   (and sets `MediaStreamTrack.enabled = false` so the OS indicator reflects
   the pause); resuming clears the flag and re-enables tracks. The session,
   chunker, and note all persist across pause/resume. A half-filled chunk is
   discarded on pause boundaries *only* in the sense that nothing is
   transcribed while paused — buffered samples collected before pausing are
   kept and chunking continues on resume.

5. **Note lifecycle.** On start, create the note immediately in the configured
   output folder using the existing `transcriptionNoteContent()` from
   `src/note.ts` (title `<date> Live recording (<source>)`, `source:
   "live-<source>"` in frontmatter, empty `## Transcript` body). As each chunk
   is decoded, append its text into the note's `## Transcript` section via a
   new pure helper `appendToTranscriptSection()` + `vault.modify()`. On stop,
   flush any buffered partial chunk (if ≥ 1 s of audio) through one final
   transcription. If no text was ever produced, leave the note with a
   "_No speech detected._" placeholder line.

## Files to change

### New: `src/live.ts`

Framework-free capture/session logic so it stays unit-testable; Obsidian and
DOM APIs are injected.

- `export type LiveAudioSource = "microphone" | "system";`
- `export class LiveChunker` — **pure, unit-tested**:
  - `constructor(opts: { sampleRate: number; chunkSeconds: number; overlapSeconds?: number })`
  - `push(samples: Float32Array): Float32Array[]` — buffers samples; returns
    zero or more full chunks of `chunkSeconds * sampleRate` samples. With
    `overlapSeconds > 0` (default 0.5 s), each emitted chunk begins
    `overlapSeconds` before the previous chunk ended so words split at the
    boundary are still recognized (duplicated words at seams are accepted —
    no dedup logic).
  - `flush(): Float32Array | null` — returns the remaining buffered samples
    (≥ 1 s) or `null`; used at stop.
  - `reset(): void`.
- `export interface LiveCaptureDeps` — injected factories:
  `getUserMedia(constraints)`, `getDisplayMedia(constraints)`,
  `enumerateDevices()`, `createAudioContext(sampleRate)`. Keeps the session
  testable headlessly.
- `export class LiveRecordingSession`:
  - `constructor(deps, opts: { chunkSeconds: number; onChunk(pcm: Float32Array): void; onError(e: Error): void })`
  - `async start(source: LiveAudioSource, deviceId?: string): Promise<void>` —
    acquires the `MediaStream` (see decision 3; for `"system"` tries
    `getDisplayMedia` first, throws a descriptive `Error` when no audio track
    is available so the caller can show the loopback Notice), builds the
    `AudioContext`(16 kHz) + source + `ScriptProcessorNode`(4096, 1, 1) graph,
    feeds frames through `LiveChunker`, calls `onChunk` for each full chunk.
  - `pause(): void` / `resume(): void` — flag + `track.enabled` toggling;
    `isPaused(): boolean`.
  - `async stop(): Promise<Float32Array | null>` — tears down the graph,
    stops tracks, closes the context, returns `chunker.flush()` output.
  - `elapsedSeconds(): number` (accumulated unpaused time, for the UI timer).

### New: `src/live-modal.ts`

`LiveRecordingModal extends Modal` — the interactive control:

- **Source** dropdown: `Microphone` / `System audio`.
- **Input device** dropdown (audioinput devices from `enumerateDevices()`;
  first entry "System default"). Visible always; description text notes that
  loopback devices for system audio are selected here.
- **Start / Stop** button (toggles; red/recording styling via existing
  Obsidian button classes only — no custom stylesheet).
- **Pause / Resume** button, disabled until recording starts; label flips.
- Status line (`Idle` / `● Recording 12:34` / `⏸ Paused 03:10` /
  `Transcribing chunk…`) driven by a 1 s interval timer, cleaned up on close.
- Closing the modal while recording asks nothing fancy — it stops the session
  (flush + final transcribe) first.
- The modal owns a `LiveRecordingSession`; its `onChunk` callback queues
  chunks through a **serial async pump** (chunks transcribe one at a time in
  arrival order; a backlog simply waits — Parakeet int8 decodes 15 s of audio
  in well under 15 s on a desktop CPU).
- After each chunk: `text = await transcribe(pcm, modelDir)`; if non-empty,
  `vault.read(note)` → `appendToTranscriptSection(content, text)` →
  `vault.modify(note, updated)`. Mirror progress to the plugin status bar via
  a callback passed in from `main.ts`.
- Model-file guard: reuse the plugin's missing-model check before starting;
  refuse to start with the same Notice text as the file-based path.

### `src/note.ts` — add one pure helper

```ts
export function appendToTranscriptSection(markdown: string, text: string): string
```

Appends `text.trim()` as a new paragraph at the end of the `## Transcript`
section (before the next `## ` heading, or end of file). If no
`## Transcript` heading exists, append `\n\n## Transcript\n\n<text>\n` at the
end. Mirrors the heading-scan style already used by `insertSummarySection`.
Add unit tests (see below).

### `src/main.ts` — wire it up

- Import `LiveRecordingModal` and `LiveAudioSource`.
- `addCommand({ id: "transcribe-live-recording", name: "Transcribe live meeting (record audio)", callback: () => new LiveRecordingModal(this.app, this).open() })`.
- `addRibbonIcon("microphone", "Transcribe live meeting", ...)` opening the
  same modal.
- Extract the shared note-creation core out of `createTranscriptionNote(file,
  transcript)` into a private `createNote(baseName: string, sourceLabel:
  string, transcript: string): Promise<TFile>` (returns the created `TFile`)
  that both the file path and the live modal use. Keep the existing method's
  external behavior identical (it calls `createNote(file.basename,
  `[[${file.path}]]`, transcript)`). The live modal calls
  `createNote(\`Live recording (${source})\`, \`live-${source}\`, "")` at
  session start and gets back the `TFile` to append into.
- Expose package-private helpers the modal needs (`resolveModelDir`,
  `findMissingModelFiles`, `setStatus`) — make them public or pass closures in
  the modal constructor; prefer passing a small interface
  (`{ settings, resolveModelDir, findMissingModelFiles, createNote, setStatus }`)
  so the modal doesn't reach into `Plugin` privates.
- Do **not** change the existing file-transcription command's behavior.

### `src/settings.ts` — settings + honest system-audio text

- Extend `TranscriberSettings` with:
  - `liveAudioSource: "microphone" | "system"` (default `"microphone"`) —
    pre-selects the modal's source dropdown.
  - `liveChunkSeconds: number` (default `15`).
- Update `DEFAULT_SETTINGS` accordingly.
- Add to the settings tab:
  - "Live recording source" dropdown setting whose description states the
    platform requirement: *"System audio capture is not exposed to Obsidian on
    most platforms. On macOS install a loopback driver (e.g. BlackHole) and
    select it as the input device; on Windows use Stereo Mix / VB-CABLE or
    screen-share audio; on Linux select a PulseAudio/PipeWire monitor source.
    The plugin will never silently fall back to the microphone."*
  - "Live chunk length (seconds)" number/text setting (clamped 5–60, default
    15) with a one-line description.

### `tests/live.test.ts` — new

- `LiveChunker`: emits nothing until a full chunk accumulates; emits exactly
  floor(total/chunk) chunks; `flush()` returns remainder ≥ 1 s and `null` for
  shorter; overlap chunks start `overlapSeconds` early; `reset()` clears.
- `LiveRecordingSession` with stubbed `LiveCaptureDeps` (fake MediaStream with
  `enabled`-settable tracks, fake AudioContext/ScriptProcessor whose
  `onaudioprocess` the test drives manually):
  - `pause()` drops frames (no samples reach the chunker) and sets
    `track.enabled = false`; `resume()` restores both.
  - `stop()` stops all tracks, closes the context, returns flushed samples.
  - `start("system", ...)` throws the descriptive error when
    `getDisplayMedia` returns a stream without an audio track, and does not
    touch the microphone path.

### `tests/note.test.ts` — extend

- `appendToTranscriptSection`: appends at end of transcript section; preserves
  following `## ` sections; creates the section when absent; idempotent
  paragraph spacing (no blank-line pileup across repeated appends).

### `README.md` — document it

- New bullet under **Commands** for "Transcribe live meeting".
- New **Live recording** section: how the modal works (source dropdown, device
  dropdown, pause/resume, stop; transcript appends as you speak in ~15 s
  chunks), plus a **System audio capture** subsection with the per-platform
  requirements (macOS loopback driver such as BlackHole + select it as input
  device; Windows Stereo Mix / VB-CABLE or screen-share audio; Linux
  PulseAudio/PipeWire monitor source) and the microphone-permission prompt on
  first use. Explicitly state there is no silent fallback to the microphone.
- Add the two new settings rows to the settings table.

## Verification

1. `npm test` — all existing + new vitest suites pass.
2. `npx tsc --noEmit` — clean.
3. `npm run build` — clean (includes `tsc -noEmit -skipLibCheck` + esbuild
   production bundle).
4. Manual smoke (documented in PR notes, not automated): run **Transcribe live
   meeting**, pick Microphone, start, speak ~30 s, pause (status shows paused,
   no text added while paused), resume, stop — note in `Meetings/` contains
   the speech as appended paragraphs that appeared during the session.

## Constraints & gotchas

- esbuild `target: es2018`, format CJS, externals include `obsidian`,
  `electron`, `sherpa-onnx-node` — new code must not import Node-only modules
  in the modal/capture path beyond what's already external.
- Keep `sherpa-onnx-node` lazily `require`d (as `transcribe()` already does);
  the chunk pump must import nothing native at module load.
- Vitest runs headless: no `AudioContext`/`navigator` at module top level —
  everything behind injected factories or modal runtime code.
- One transcription at a time per session (serial pump); starting a second
  live session while one is active shows a Notice and refuses.
- Desktop only is already declared (`isDesktopOnly: true`); no manifest change
  needed. `minAppVersion` unchanged.

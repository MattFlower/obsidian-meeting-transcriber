# Live meeting recording

## What changed

The plugin now records a live meeting from either a **Microphone** or
**System audio** source and appends locally transcribed text to an Obsidian
note while the meeting is still in progress. The interactive control is the
**Transcribe live meeting (record audio)** command and the microphone ribbon
icon; both open the live-recording modal.

A recording creates a note in the configured output folder when capture starts,
using a name like `YYYY-MM-DD HHmm Live recording (microphone).md` or
`...(system).md`. Its frontmatter identifies the source as `live-microphone`
or `live-system`. Audio is captured as 16 kHz mono PCM, divided into chunks
(default 15 seconds; configurable from 5 to 60 seconds), and sent serially to
the local Parakeet recognizer. Each completed chunk is appended as a paragraph
under `## Transcript`, so text appears during the meeting rather than only
when recording ends. Chunks overlap by the default 0.5 seconds to help words
crossing boundaries, so a short delay and occasional seam duplication are
expected.

The modal and Obsidian status bar show unpaused elapsed time and transcription
activity. **Pause** disables the capture tracks and drops incoming frames while
keeping the session and buffered samples; **Resume** re-enables capture and
continues the same note. **Stop recording**, or closing the modal, tears down
capture and transcribes the final partial buffer when it contains at least one
second of audio. If no text was produced, the note receives
`_No speech detected._`.

Only one live session may be active across the plugin. A second attempt is
refused with a Notice until the first session has been stopped. This also
applies while the first modal is still waiting for permission or capture to
start.

## System-audio requirements

System audio is not guaranteed to be exposed by Obsidian's Electron host. On
most platforms, the user must provide a loopback/monitor input and select it
in the modal's **Input device** dropdown:

- **macOS:** install or configure a loopback source such as BlackHole or an
  Audio MIDI Setup aggregate/loopback, then route the desired application audio
  into it. On macOS 13+, screen sharing may provide system audio when
  screen-recording permission is granted.
- **Windows:** use Stereo Mix, a virtual cable such as VB-CABLE, or screen-share
  audio when the Windows share prompt provides it.
- **Linux:** use a PulseAudio/PipeWire monitor source, such as the monitor of
  the relevant sink.

With System audio selected and no usable system-audio track available, the
plugin shows a Notice explaining that a loopback input is required and asks
the user to select one. It does **not** silently fall back to the microphone.
With no device selected, it may request screen sharing and use its audio track
when the platform supplies one; video is discarded. Microphone capture uses the
normal OS permission prompt on first use.

## Where it lives and how to use or verify it

- `src/live-modal.ts` implements the modal, source/device selection,
  start/pause/resume/stop controls, status updates, model checks, serial
  transcription pump, note creation, and user notices.
- `src/live.ts` implements the framework-free audio session, 16 kHz capture,
  chunking/flushing, pause timing, track/context cleanup, system-audio
  selection, and the plugin-wide session registry.
- `src/main.ts` registers the command and ribbon icon, exposes the live-session
  host operations, and shares note creation with the existing path.
- `src/note.ts` provides the incremental `## Transcript` append operation.
- `src/settings.ts` adds the preselected live source and chunk-length settings;
  `README.md` documents the controls and platform setup.

To use it, first ensure the local Parakeet model is installed, open the command
or ribbon microphone, choose the source and input device, and press **Start
recording**. Confirm that the note appears in the output folder and that
paragraphs arrive under `## Transcript`; pause/resume and stop to verify the
lifecycle and final flush. The automated coverage is in `tests/live.test.ts`
(audio paths, chunking, pause/resume, unavailable system audio, cleanup, and
single-session refusal) and `tests/note.test.ts` (incremental transcript
appending).

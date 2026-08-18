Replace the live-recording modal with a dockable sidebar panel. The modal is
awkward: it blocks the vault while recording, so the note cannot be read or
edited during the meeting it is transcribing.

The panel is an Obsidian sidebar view containing a source selector (microphone /
system audio), an input-device dropdown, start / pause / resume / stop controls,
and live status showing elapsed unpaused time, current transcription activity,
and which note is being written to. The existing "Transcribe live meeting
(record audio)" command and the microphone ribbon icon must open or reveal the
panel instead of opening the modal.

Where: src/live-modal.ts (LiveRecordingModal, which implements LiveSessionOwner
and owns the TranscriptOverlapDeduper), src/main.ts (the command registered
around line 88, the ribbon icon around line 96, openLiveRecordingModal, and
claimLiveSession / releaseLiveSession, which currently take the modal),
src/live.ts, and tests/live.test.ts.

Done means: recording is controlled entirely from the sidebar panel with no
modal anywhere in the flow; the note stays readable and editable while recording;
and every existing behaviour still holds —

  - pause and resume suspend and continue capture without ending the session
  - transcript text is appended incrementally under ## Transcript during the
    meeting, not only at the end
  - chunk-seam de-duplication still removes overlapping text and still applies
    the clipped-word correction
  - system audio still throws explicit guidance when unavailable and never
    silently falls back to the microphone
  - the final partial buffer is still flushed on stop, and the no-speech
    placeholder is still written when nothing was transcribed
  - the single-session guard still refuses a second live session while one is
    claimed or recording, including during a pending start

`npm test`, `npx tsc --noEmit`, and `npm run build` all pass.

Out of scope: the file-based transcription path, the summarize / tagging
feature, changing chunk length or the audio overlap, and changing what text gets
written into the note. Do not modify adws/ or .claude/.

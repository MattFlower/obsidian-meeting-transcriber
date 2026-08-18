Add an interactive control that transcribes live meeting audio directly into an
Obsidian note. Right now there is only a way to transcribe existing meeting
audio. The control must be able to capture either the microphone or system
audio, and must have a button to pause recording.

Where: this plugin's existing TypeScript source under src/ — src/audio.ts and
src/transcriber.ts already handle audio and Parakeet transcription for the
file-based path, and src/main.ts registers the plugin's commands.

Done means: a control in Obsidian starts a live recording session; the user can
choose microphone or system audio as the source; a pause button suspends capture
and resumes it without ending the session; and the transcript reaches the note
as the meeting is spoken rather than only at the end. `npm test`,
`npx tsc --noEmit`, and `npm run build` all pass.

Out of scope: changing the existing file-based transcription path, the summarize
/ tagging feature, speaker diarization, cloud transcription services, and
submitting to the Obsidian community plugin registry. Do not modify adws/ or
.claude/.

Note on system audio: capturing it is a real platform constraint, not an
oversight — Electron cannot record system output the way it records a
microphone. If it requires a loopback device, a permission prompt, or a
platform-specific API, implement what the platform actually supports and state
the requirement in the plugin's settings UI and its README rather than silently
falling back to the microphone.

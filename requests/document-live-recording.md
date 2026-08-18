Write up the live meeting recording feature this change adds — the interactive
control that transcribes live audio into an Obsidian note, its microphone and
system-audio capture, the pause/resume behaviour, and how the transcript reaches
the note while the meeting is still being spoken.

Where: app_docs/

Done means: a write-up in app_docs/ that a reader who has not seen this diff can
use to understand what the feature does and how to use it, including the
system-audio requirements a user must satisfy on their own machine and what
happens when the platform cannot provide system audio.

Out of scope: the file-based transcription path and the summarize/tagging
feature, both of which predate this change; the single-session guard's internal
claim/release mechanics beyond the user-visible rule that a second live session
refuses to start while one is active. Do not modify adws/ or .claude/.

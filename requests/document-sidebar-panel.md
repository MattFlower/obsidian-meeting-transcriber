Write up the move of the live recording controls out of a modal and into a
dockable sidebar panel — what the panel contains, how it is opened, and what
changed for someone who used the old modal.

Where: app_docs/

Done means: a write-up in app_docs/ that a reader who has not seen this diff can
use. It should cover how to open the panel (the command and the ribbon icon),
what the panel contains and what its status readout shows, that the note stays
readable and editable while recording, and the raised minimum Obsidian version
with the reason.

Out of scope: restating the live-recording behaviours that did not change in
this diff — capture, pause/resume semantics, seam de-duplication, the
system-audio requirements — beyond what is needed to describe the panel;
app_docs/e1c3ce74_live-meeting-recording.md already documents those. Do not
document the file-based transcription path or the summarize/tagging feature. Do
not modify adws/ or .claude/.

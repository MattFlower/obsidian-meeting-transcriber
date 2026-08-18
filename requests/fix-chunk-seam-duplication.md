Remove the duplicated text that appears where live-transcription chunks overlap.

Consecutive chunks deliberately overlap — default 0.5 seconds, see
src/live.ts:26-27 and the overlapSamples computation at src/live.ts:48 — so that
words crossing a chunk boundary are not lost. But nothing removes that overlap
from the transcribed text, so words inside it are appended to the note twice:
once from the end of one chunk and again from the start of the next.

Where: src/live.ts (chunking and the overlap constant), src/live-modal.ts (the
transcribeChunk path that appends each result to the note), tests/live.test.ts.

Done means: text spanning a chunk boundary appears exactly once in the note; the
overlap is still captured so boundary words are not lost; and tests cover both
sides of that — a phrase crossing a seam is neither duplicated nor truncated.
`npm test`, `npx tsc --noEmit`, and `npm run build` all pass.

Out of scope: removing or zeroing the audio overlap itself — dropping it would
trade duplicated words for lost ones, which is the problem the overlap exists to
prevent. Also out of scope: changing the chunk-length setting or its 5–60 second
range, the file-based transcription path, the summarize/tagging feature, and the
single-session guard. Do not modify adws/ or .claude/.

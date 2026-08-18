Fix the concurrent-start race in the live recording session guard. Starting a
second live session while one is active must show a Notice and refuse.

A successful claim must reserve the plugin-wide slot until that same modal
releases it — including while a start is still pending, and if the modal is
closed during a permission prompt. Refusal must not be based solely on
owner.isRecording().

The reviewer's finding, verbatim: src/live.ts:407-423 treats a claimed but
not-yet-recording owner as inactive, so another modal can replace it while the
first awaits async session.start() at src/live-modal.ts:313-324; both starts can
then complete.

Where: src/live.ts and src/live-modal.ts, both already in the working tree and
uncommitted.

Done means: a second live session cannot start while a first is claimed or
recording — it shows a Notice and refuses, and the guard holds when the second
attempt arrives during the first's pending start. `npm test`,
`npx tsc --noEmit`, and `npm run build` all pass.

Out of scope: the ten requirements this review already accepted — microphone
capture, system-audio capture and its explicit unavailable-guidance, pause and
resume, incremental note writing, the live-recording settings, and the README.
Do not restructure or rewrite them to fix this. Do not modify adws/ or .claude/.

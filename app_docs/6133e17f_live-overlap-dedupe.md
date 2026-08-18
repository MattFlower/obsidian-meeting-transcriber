# Live transcription seam de-duplication

## What changed

Live transcription now removes repeated text caused by the intentional audio overlap between consecutive chunks. `src/live.ts` adds the pure `TranscriptOverlapDeduper`, which compares a bounded tail of previously emitted words with the next chunk’s prefix, ignoring case and edge punctuation. It can also recognize a clipped boundary word (for example, `transcri` followed by `transcription`) and exposes a correction so the fuller recognition replaces the already-appended word.

The audio overlap itself is unchanged: `LiveChunker` still defaults to 0.5 seconds, and its overlap/clamping and chunk-length behavior remain intact. The chunker documentation now points to downstream transcript de-duplication.

## Where it is wired

`src/live-modal.ts` keeps one deduper for the recording session, resets it when a session starts, and runs each transcribed chunk through it before modifying the note. Empty fully-overlapped results are skipped, while `producedText` is still set whenever transcription returns text. If a clipped word is completed by the next chunk, the modal updates the final word in the Transcript section before appending any new suffix.

## Tests and verification

`tests/live.test.ts` covers first append/reset, empty input, non-overlapping chunks, case and punctuation differences, fully duplicated chunks, chained overlaps, clipped seam words, and the expected de-duplicated phrase. Existing `LiveChunker` overlap tests remain in place.

Verify with:

```sh
npm test
npx tsc --noEmit
npm run build
```

The request and implementation plan are recorded in `requests/fix-chunk-seam-duplication.md` and `specs/6133e17f_live-overlap-dedupe.md`.

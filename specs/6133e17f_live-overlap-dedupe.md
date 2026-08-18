# Plan: De-duplicate live-transcription text at chunk seams

Date: 2026-08-18
ADW session: 6133e17f

## Problem

`LiveChunker` (src/live.ts) deliberately emits consecutive chunks with a 0.5 s
audio overlap (default, `overlapSeconds ?? 0.5`; `overlapSamples` computed in
the constructor) so words crossing a chunk boundary are still recognized. But
`LiveRecordingModal.transcribeChunk` (src/live-modal.ts) appends each chunk's
transcript verbatim to the note via `appendToTranscriptSection`, so the words
inside the overlap are written twice — once at the end of chunk N's text and
again at the start of chunk N+1's text. The code even documents this: the
`overlapSeconds` JSDoc in src/live.ts says "there is no de-duplication."

## Goal

Text spanning a chunk boundary appears exactly once in the note. The audio
overlap itself is untouched (still captured, still default 0.5 s). `npm test`,
`npx tsc --noEmit`, and `npm run build` all pass.

## Approach

De-duplicate at the **text** level, in the transcribe-and-append path, with a
pure, headlessly-testable helper in src/live.ts. The modal keeps one helper
instance per session and runs every chunk transcript through it before
appending to the note.

The overlap is at most `overlapSeconds` of speech — a handful of words — so a
word-level longest-suffix/prefix match between the tail of the already-emitted
text and the head of the new chunk's text is sufficient and robust.

## Changes

### 1. src/live.ts — new pure dedupe helper

Add a framework-free class (alongside `LiveChunker`), e.g.:

```ts
export class TranscriptOverlapDeduper {
  private prevWords: string[] = []; // normalized tail of last emitted text
  /** Returns `text` with the prefix already emitted by the previous chunk removed. */
  append(text: string): string;
  reset(): void;
}
```

Algorithm for `append(text)`:

1. Tokenize `text` into words (split on whitespace). If empty, return `""`.
2. Normalize each word for comparison only: lowercase and strip leading/
   trailing punctuation (keep the original tokens for output).
3. Find the largest `k` (bounded by both word counts) such that the last `k`
   normalized words of the previous emitted text equal the first `k` normalized
   words of the new text. Two words also count as equal when one is a prefix
   of the other (ASR may clip a word at the seam, e.g. "transcri" vs
   "transcription") — this only applies to the *outermost* matched word pair
   (last word of prev / first word of next), not to interior pairs.
4. Return the new text with its first `k` words removed (leading whitespace
   trimmed), and update `prevWords` to the normalized tail of the **full
   emitted text so far** (previous tail + the returned suffix), keeping only
   the last ~20 words — the seam never spans more than that.
5. `reset()` clears state (used on session start).

Edge cases to get right:

- First chunk after construction/`reset()`: returned unchanged.
- No word overlap: returned unchanged.
- New text entirely consumed by the overlap: return `""` (caller skips the
  append but still counts it as produced speech).
- Matching must be bounded (compare only the tail window), not O(n²) over the
  whole transcript.

Also update the stale `overlapSeconds` JSDoc on `LiveChunkerOptions` (currently
"Words duplicated at the seams are accepted — there is no de-duplication.") to
say seam duplication is removed downstream by `TranscriptOverlapDeduper` in the
modal's append path. Do **not** change the overlap default, the clamping logic,
or `LiveChunker` itself.

### 2. src/live-modal.ts — wire the helper into transcribeChunk

- Import `TranscriptOverlapDeduper` from `./live`.
- Add a private field `private readonly deduper = new TranscriptOverlapDeduper();`.
- In `startSession()`, where `this.producedText = false; this.pump = Promise.resolve();`
  is reset, also call `this.deduper.reset()` (new note, new text stream).
- In `transcribeChunk()`, replace the verbatim append:

  ```ts
  const text = await transcribe(pcm, modelDir);
  if (text) {
    this.producedText = true;
    const deduped = this.deduper.append(text);
    if (deduped) {
      const content = await this.app.vault.read(note);
      await this.app.vault.modify(
        note,
        appendToTranscriptSection(content, deduped),
      );
    }
  }
  ```

  Note: `producedText` is set whenever the recognizer returned text, even if
  the deduper consumed all of it — otherwise the "No speech detected"
  placeholder in `stopSession()` would wrongly fire for fully-overlapped
  speech.

No other modal changes: the serial pump, stop/tail handling, and session guard
all stay as they are.

### 3. tests/live.test.ts — cover both sides of the seam

Add a `describe("TranscriptOverlapDeduper", ...)` block importing the new
class from `../src/live`. Cases:

- **No duplication across a seam:** prev "hello world this is", next
  "this is a test" → append returns "a test"; concatenation contains the
  boundary phrase ("this is") exactly once.
- **Boundary words are not lost:** when there is genuinely no overlap
  ("hello world" then "goodbye now"), the second text is returned verbatim —
  nothing is truncated.
- **First append** returns text unchanged; **`reset()`** makes the next
  append behave like a first append.
- **Case/punctuation tolerance:** prev ends "… the quick, brown fox" and next
  starts "The quick brown fox jumps" → seam words deduped despite case and
  comma differences.
- **Clipped word at the seam:** prev ends "transcri", next starts
  "transcription of the meeting" → the prefix-clipped pair matches and the
  fuller word is kept exactly once.
- **Fully overlapped chunk:** next text entirely contained in prev's tail →
  returns `""`.
- **Chained appends:** three chunks where each consecutive pair overlaps by a
  few words → the joined result contains each phrase exactly once (simulates
  the live stream).
- Empty string append returns `""`.

Existing `LiveChunker` overlap tests must keep passing unmodified — the audio
overlap itself is unchanged.

## Out of scope (do not touch)

- Removing/zeroing the audio overlap or changing the 5–60 s chunk-length
  setting/range.
- The file-based transcription path, summarize/tagging, single-session guard.
- `adws/` and `.claude/` (other than this plan file under the handoff dir).

## Verification

1. `npm test` — new dedupe tests + all existing tests pass.
2. `npx tsc --noEmit` — no type errors.
3. `npm run build` — esbuild bundle succeeds.

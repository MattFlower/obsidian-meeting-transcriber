/**
 * Live meeting recording: capture microphone or system audio with the Web
 * Audio API (an AudioWorklet on the audio rendering thread), cut the PCM
 * into fixed-length chunks, and hand each finished chunk to a callback (the
 * panel transcribes it with the shared offline Parakeet recognizer and
 * appends the text to the note).
 *
 * This module is framework-free: Obsidian/DOM APIs are injected through
 * `LiveCaptureDeps` so the session logic stays unit-testable headlessly.
 * No native modules are imported here — `transcribe()` (which lazily
 * requires `sherpa-onnx-node`) lives in the panel's pump.
 */

import type { TimedWord } from "./transcriber";

export type LiveAudioSource = "microphone" | "system" | "both";

/**
 * A lane is one captured input. A single-source session has one `mixed`
 * lane; a `"both"` session captures the microphone as `me` and the loopback
 * device as `others`, sample-aligned because one worklet reads both.
 */
export type LiveLane = "mixed" | "me" | "others";

/** Samples per lane cut from the same render quanta (equal lengths). */
export type LiveFrame = Partial<Record<LiveLane, Float32Array>>;

/** One transcription window: a chunk per lane cut from the same samples. */
export interface LiveWindow {
  /** 0-based sequence number within the session. */
  index: number;
  /** Where the window starts in the session's unpaused timeline (seconds). */
  startSeconds: number;
  lanes: LiveFrame;
}

/** A transcribed word placed on the session timeline, tagged with its lane. */
export interface LaneWord extends TimedWord {
  lane: LiveLane;
}

/** Display label for a lane's turns in the note; the mixed lane has none. */
export function laneLabel(lane: LiveLane): string {
  if (lane === "me") return "Me";
  if (lane === "others") return "Others";
  return "";
}

export function lanesForSource(source: LiveAudioSource): LiveLane[] {
  return source === "both" ? ["me", "others"] : ["mixed"];
}

/** The lane fed by the loopback (system audio) device, if the source has one. */
export function loopbackLane(source: LiveAudioSource): LiveLane | null {
  if (source === "both") return "others";
  if (source === "system") return "mixed";
  return null;
}

export interface BleedFilterOptions {
  /** Largest start-time difference (seconds) between a word and its echo. */
  windowSeconds?: number;
  /** Shortest run of consecutive echoed `me` words that counts as bleed. */
  minRun?: number;
}

export const DEFAULT_BLEED_FILTER: Required<BleedFilterOptions> = {
  windowSeconds: 0.6,
  minRun: 2,
};

/**
 * Remove the microphone's copy of the far end. Without headphones the
 * microphone hears the loudspeakers, so the loopback lane's words come back
 * on the `me` lane a few tens of milliseconds apart, in either direction:
 * the two capture paths buffer differently and Parakeet's timestamps are
 * 80 ms frames. A `me` word is an echo when an `others` word with the same
 * text (ignoring case and punctuation) starts within `windowSeconds` of it
 * and the matches come in order; only runs of at least `minRun` consecutive
 * echoes are dropped, so a genuine "yes" right after the far end's "yes"
 * survives. Other lanes and the `others` lane itself are returned as they
 * are, in the original order. Pure so it can be tested.
 */
export function dropLoopbackBleed(
  words: LaneWord[],
  opts: BleedFilterOptions = {},
): LaneWord[] {
  const windowSeconds = opts.windowSeconds ?? DEFAULT_BLEED_FILTER.windowSeconds;
  const minRun = opts.minRun ?? DEFAULT_BLEED_FILTER.minRun;
  const others = words
    .filter((word) => word.lane === "others")
    .map((word) => ({ key: normalizeTranscriptWord(word.text), start: word.start }));
  if (others.length === 0) return words;

  const meIndexes: number[] = [];
  words.forEach((word, i) => {
    if (word.lane === "me") meIndexes.push(i);
  });
  const matched: boolean[] = meIndexes.map(() => false);
  let next = 0;
  for (let k = 0; k < meIndexes.length; k++) {
    const word = words[meIndexes[k]];
    const key = normalizeTranscriptWord(word.text);
    if (key.length === 0) continue;
    while (next < others.length && others[next].start < word.start - windowSeconds) {
      next++;
    }
    for (
      let m = next;
      m < others.length && others[m].start <= word.start + windowSeconds;
      m++
    ) {
      if (others[m].key === key) {
        matched[k] = true;
        next = m + 1;
        break;
      }
    }
  }

  const drop = new Set<number>();
  let runStart = 0;
  for (let k = 0; k <= meIndexes.length; k++) {
    if (k < meIndexes.length && matched[k]) continue;
    if (k - runStart >= minRun) {
      for (let r = runStart; r < k; r++) drop.add(meIndexes[r]);
    }
    runStart = k + 1;
  }
  return drop.size === 0 ? words : words.filter((_, i) => !drop.has(i));
}

/**
 * Constraints that switch the browser's voice processing off for a loopback
 * device: system audio is already clean, and echo cancellation, noise
 * suppression and gain control only distort it.
 */
export const LOOPBACK_AUDIO_PROCESSING = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

/**
 * Whether a chunk holds no signal at all. A loopback device that nothing is
 * routed into delivers exact zeros, unlike a microphone with its noise
 * floor, so this is only meaningful for the loopback lane. Pure so it can be
 * tested.
 */
export function isSilent(pcm: Float32Array, threshold = 1e-4): boolean {
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) >= threshold) return false;
  }
  return true;
}

/**
 * Where a session writes its audio while it runs (a WAV in a temp folder),
 * declared structurally so the session and panel import nothing from
 * `node:fs` and tests inject a fake.
 */
export interface LiveAudioSink {
  readonly path: string;
  /** Set once the underlying stream failed; later writes are no-ops. */
  readonly failed: Error | null;
  /** One buffer per lane, in the session's lane order. */
  write(lanes: Float32Array[]): void;
  close(): Promise<unknown>;
  /** Discard the file (safe after a failure or when nothing was said). */
  abort(): Promise<void>;
}

/** What the speaker pass needs from a stopped live session. */
export interface LiveSpeakerSource {
  words: LaneWord[];
  /** Absolute path of the WAV holding the session's audio, one channel per lane. */
  audioPath: string;
  lanes: LiveLane[];
}

/**
 * Words spread evenly over `seconds` for a chunk whose recognizer reported
 * no timestamps: alignment degrades to "somewhere in this chunk" instead
 * of failing. Pure so it can be tested.
 */
export function spreadWords(text: string, seconds: number): TimedWord[] {
  const tokens = text.match(/\S+/g) ?? [];
  const span = Math.max(0, seconds) / Math.max(1, tokens.length);
  return tokens.map((token, i) => ({
    text: token,
    start: i * span,
    end: (i + 1) * span,
  }));
}

/** Sample rate the Parakeet model expects; capture is done at this rate. */
export const LIVE_SAMPLE_RATE = 16000;

/** Error message fragment callers can match on for the loopback guidance. */
export const SYSTEM_AUDIO_UNAVAILABLE =
  "System audio is not available directly on this platform";

export interface LiveChunkerOptions {
  sampleRate: number;
  chunkSeconds: number;
  /**
   * Seconds of overlap between consecutive chunks (default 0.5). Each
   * emitted chunk begins `overlapSeconds` before the previous chunk ended,
   * so words split at a boundary are still recognized. TranscriptOverlapDeduper
   * removes duplicated seam text downstream in the modal's append path.
   */
  overlapSeconds?: number;
}

const TRANSCRIPT_TAIL_WORDS = 20;

/** Runs of characters that are neither letters nor digits at a token's edges. */
const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u;
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}]+$/u;

/**
 * Punctuation worth carrying from a clipped word onto its fuller replacement.
 * Connectors such as a hyphen or a decimal point belong to the cut word
 * itself ("self-" / "self-driving") and are deliberately excluded.
 */
const SENTENCE_PUNCTUATION = /[.,;:!?…"”)\]]+$/u;

/**
 * Shortest fragment that may be treated as a boundary-clipped word when no
 * exact-match word anchors it in the overlap window. Shorter fragments
 * ("a"/"and", "in"/"into", "do"/"don't") are almost always real words.
 */
const MIN_UNANCHORED_CLIP_LENGTH = 4;

/**
 * Common English words that are complete on their own even though they
 * prefix unrelated longer words ("with"/"without", "some"/"something",
 * "form"/"format"). Without an anchor word they are kept as real words
 * rather than clipped fragments. Inflected and contracted forms are handled
 * generically by WORD_SUFFIXES, so this list only needs to cover words that
 * start compounds and derivations.
 */
const COMPLETE_SHORT_WORDS = new Set([
  "about", "after", "again", "also", "back", "been", "before", "being",
  "both", "come", "could", "does", "done", "down", "each", "else", "even",
  "ever", "every", "first", "form", "from", "give", "good", "have", "here",
  "into", "just", "know", "last", "like", "look", "made", "make", "many",
  "more", "most", "much", "must", "need", "next", "none", "once", "only",
  "other", "over", "part", "real", "said", "same", "shall", "should",
  "some", "still", "such", "sure", "take", "than", "that", "them", "then",
  "there", "these", "they", "thing", "this", "those", "time", "under",
  "upon", "very", "want", "well", "went", "were", "what", "when", "where",
  "which", "while", "will", "with", "work", "would", "your",
]);

/**
 * Suffixes that turn a complete word into an inflected or contracted form.
 * "start"/"started" or "did"/"didn't" at a seam is far more often two real
 * words across a pause than a boundary clip, and merging them silently
 * deletes a clause, so such pairs are only merged when two exact-match
 * words anchor the seam. The cost of being wrong is a visible duplicate.
 */
const WORD_SUFFIXES = new Set([
  "s", "es", "ed", "ing", "ly", "er", "est",
  "n't", "'s", "'re", "'ve", "'ll", "'d", "'m",
]);

interface TranscriptWordParts {
  leading: string;
  core: string;
  trailing: string;
}

/** Split a token into leading punctuation, the word itself, and trailing punctuation. */
function splitTranscriptWord(token: string): TranscriptWordParts {
  const leading = LEADING_PUNCTUATION.exec(token)?.[0] ?? "";
  const rest = token.slice(leading.length);
  const trailing = TRAILING_PUNCTUATION.exec(rest)?.[0] ?? "";
  return { leading, core: rest.slice(0, rest.length - trailing.length), trailing };
}

function normalizeTranscriptWord(token: string): string {
  return splitTranscriptWord(token).core.toLocaleLowerCase();
}

/**
 * Removes words repeated where consecutive overlapping audio chunks meet.
 * Pure (no I/O) so the live append path can be tested headlessly.
 */
interface TranscriptWord {
  normalized: string;
  original: string;
  /** The recognizer closed the word with sentence or clause punctuation. */
  endsClause: boolean;
}

function toTranscriptWord(token: string): TranscriptWord {
  const parts = splitTranscriptWord(token);
  return {
    normalized: parts.core.toLocaleLowerCase(),
    original: token,
    endsClause: SENTENCE_PUNCTUATION.test(parts.trailing),
  };
}

/**
 * Whether `fuller` is `word` plus an inflection or contraction suffix,
 * allowing for a doubled final consonant ("commit"/"committed").
 */
function isInflectionOf(word: string, fuller: string): boolean {
  const tail = fuller.slice(word.length).replace(/[’‘]/g, "'");
  if (WORD_SUFFIXES.has(tail)) return true;
  const last = word.slice(-1);
  return tail.startsWith(last) && WORD_SUFFIXES.has(tail.slice(last.length));
}

/**
 * Decide whether `previous`, the last word of the earlier chunk, is a
 * boundary clip of `fuller`, the word at the same position in the new
 * chunk. Only this direction is physically possible: the earlier chunk is
 * cut at its end, while the new chunk starts before the cut and hears the
 * whole word. `anchors` counts the exact-match words before it in the
 * overlap window; two make a coincidence negligible, one still leaves room
 * for a repeated function word across a pause ("so we did. We didn't…").
 * Without any anchor there is no proof the two chunks share audio, so a
 * word the recognizer closed with punctuation ("plan." / "Planet"), which
 * it heard complete before a pause rather than cut mid-syllable, is never
 * treated as a clip.
 */
function isClippedWord(
  previous: TranscriptWord,
  fuller: string,
  anchors: number,
): boolean {
  const word = previous.normalized;
  if (word.length === 0 || word === fuller) return false;
  if (!fuller.startsWith(word)) return false;
  if (anchors >= 2) return true;
  if (isInflectionOf(word, fuller)) return false;
  if (anchors === 1) return true;
  return (
    !previous.endsClause &&
    word.length >= MIN_UNANCHORED_CLIP_LENGTH &&
    !COMPLETE_SHORT_WORDS.has(word)
  );
}

/** Give `word` the capitalization of `model`'s first letter, when it has one. */
function matchLeadingCase(model: string, word: string): string {
  const modelHead = Array.from(model)[0];
  const wordHead = Array.from(word)[0];
  if (!modelHead || !wordHead) return word;
  const upper = modelHead.toLocaleUpperCase();
  if (upper === modelHead.toLocaleLowerCase()) return word;
  const head =
    modelHead === upper
      ? wordHead.toLocaleUpperCase()
      : wordHead.toLocaleLowerCase();
  return head + word.slice(wordHead.length);
}

/**
 * Build the note replacement for a clipped word from the fuller recognition.
 * The clipped word owns its place in the note, so its leading punctuation
 * and capitalization are kept. The new chunk heard the whole word and what
 * follows it, so its trailing punctuation wins; when it has none and the
 * chunk goes on, the sentence continues and the clipped word's chunk-final
 * punctuation is dropped. Only when nothing follows the fuller word is the
 * clipped word's own sentence punctuation kept.
 */
function mergeClippedWord(
  clipped: string,
  fuller: string,
  sentenceContinues: boolean,
): string {
  const before = splitTranscriptWord(clipped);
  const after = splitTranscriptWord(fuller);
  const core = matchLeadingCase(before.core, after.core);
  const trailing =
    (after.trailing || sentenceContinues)
      ? after.trailing
      : (SENTENCE_PUNCTUATION.exec(before.trailing)?.[0] ?? "");
  return before.leading + core + trailing;
}

export interface TranscriptWordCorrection {
  previous: string;
  replacement: string;
}

export class TranscriptOverlapDeduper {
  private prevWords: TranscriptWord[] = [];
  private correction: TranscriptWordCorrection | null = null;

  /** Return `text` without a prefix already emitted by the previous chunk. */
  append(text: string): string {
    const matches = Array.from(text.matchAll(/\S+/g));
    const overlap = this.consume(matches.map((match) => match[0]));
    if (matches.length === 0) return "";
    if (overlap === 0) return text;
    if (overlap === matches.length) return "";
    const firstRemaining = matches[overlap];
    return text.slice(firstRemaining.index ?? 0).trimStart();
  }

  /**
   * The word-object form of `append`: the words not already emitted by the
   * previous chunk, with whatever else they carry (timestamps, a lane) kept.
   */
  appendWords<T extends { text: string }>(words: T[]): T[] {
    const overlap = this.consume(words.map((word) => word.text));
    return words.slice(overlap);
  }

  /** Match `tokens` against the tail, record any correction, return the overlap. */
  private consume(tokens: string[]): number {
    this.correction = null;
    if (tokens.length === 0) return 0;

    const words = tokens.map((token) => toTranscriptWord(token));
    const maxOverlap = Math.min(this.prevWords.length, words.length);
    let overlap = 0;

    for (let size = maxOverlap; size > 0; size--) {
      const previousStart = this.prevWords.length - size;
      let equal = true;
      for (let index = 0; index < size; index++) {
        const previous = this.prevWords[previousStart + index];
        const next = words[index].normalized;
        const exactMatch =
          previous.normalized.length > 0 && previous.normalized === next;
        // Only the last word of the earlier chunk can be cut by the audio
        // boundary ("transcri" / "transcription"); the exact matches before
        // it in the window are the anchors that make the seam trustworthy.
        const clippedMatch =
          index === size - 1 && isClippedWord(previous, next, index);
        if (!exactMatch && !clippedMatch) {
          equal = false;
          break;
        }
      }
      if (equal) {
        overlap = size;
        break;
      }
    }

    if (overlap > 0) {
      const previousWord = this.prevWords[this.prevWords.length - 1];
      const nextWord = words[overlap - 1];
      if (previousWord.normalized !== nextWord.normalized) {
        // The new chunk recognized a fuller version of the clipped word.
        // Tell the append path to correct the already-written final word.
        const replacement = mergeClippedWord(
          previousWord.original,
          nextWord.original,
          overlap < words.length,
        );
        this.correction = { previous: previousWord.original, replacement };
        this.prevWords[this.prevWords.length - 1] = toTranscriptWord(replacement);
      }
    }

    const emittedWords = words.filter((word, index) =>
      index >= overlap && word.normalized.length > 0,
    );
    this.prevWords = this.prevWords
      .concat(emittedWords)
      .slice(-TRANSCRIPT_TAIL_WORDS);
    return overlap;
  }

  /** Return a fuller replacement for a clipped word matched by the last append. */
  takeCorrection(): TranscriptWordCorrection | null {
    const correction = this.correction;
    this.correction = null;
    return correction;
  }

  /** Forget transcript state at the start of a new recording session. */
  reset(): void {
    this.prevWords = [];
    this.correction = null;
  }
}

/**
 * Buffers incoming mono PCM samples and emits full fixed-length chunks.
 * Pure (no I/O) so it can be unit-tested.
 */
export class LiveChunker {
  private readonly sampleRate: number;
  private readonly chunkSamples: number;
  private readonly overlapSamples: number;
  private readonly minFlushSamples: number;
  private buffer: Float32Array = new Float32Array(0);

  constructor(opts: LiveChunkerOptions) {
    this.sampleRate = opts.sampleRate;
    this.chunkSamples = Math.max(1, Math.round(opts.chunkSeconds * opts.sampleRate));
    const overlap = Math.round((opts.overlapSeconds ?? 0.5) * opts.sampleRate);
    // Clamp so the chunk window always advances.
    this.overlapSamples = Math.min(Math.max(0, overlap), this.chunkSamples - 1);
    this.minFlushSamples = Math.max(1, opts.sampleRate); // 1 second
  }

  /** Samples between the starts of two consecutive chunks. */
  get stepSamples(): number {
    return this.chunkSamples - this.overlapSamples;
  }

  /**
   * Append `samples` to the buffer and return zero or more full chunks. With
   * overlap, chunk N+1 starts `overlapSamples` before chunk N ended.
   */
  push(samples: Float32Array): Float32Array[] {
    if (samples.length === 0) return [];
    const next = new Float32Array(this.buffer.length + samples.length);
    next.set(this.buffer);
    next.set(samples, this.buffer.length);
    this.buffer = next;

    const chunks: Float32Array[] = [];
    const step = this.chunkSamples - this.overlapSamples;
    let offset = 0;
    while (this.buffer.length - offset >= this.chunkSamples) {
      chunks.push(this.buffer.slice(offset, offset + this.chunkSamples));
      offset += step;
    }
    if (offset > 0) {
      this.buffer = this.buffer.slice(offset);
    }
    return chunks;
  }

  /**
   * Return the remaining buffered samples when they amount to at least one
   * second of audio (used for the final partial chunk on stop), else null.
   */
  flush(): Float32Array | null {
    if (this.buffer.length >= this.minFlushSamples) {
      const out = this.buffer;
      this.buffer = new Float32Array(0);
      return out;
    }
    return null;
  }

  /** Clear any buffered (incomplete) samples. */
  reset(): void {
    this.buffer = new Float32Array(0);
  }
}

// ---------------------------------------------------------------------------
// Capture worklet
// ---------------------------------------------------------------------------

/** Name the capture processor is registered under in the worklet scope. */
export const CAPTURE_PROCESSOR_NAME = "meeting-transcriber-capture";

/** Mono samples per frame posted from the worklet to the main thread. */
export const CAPTURE_FRAME_SAMPLES = 4096;

/**
 * Source of the AudioWorklet module that captures the input. It runs on the
 * audio rendering thread, so capture keeps up while the renderer thread is
 * busy (Obsidian re-rendering the note after each append, for instance),
 * unlike the deprecated ScriptProcessorNode whose callback shared the main
 * thread. Each 128-sample render quantum is copied into a frame, and each
 * full frame is posted to the main thread — transferred, not cloned — where
 * the session feeds it to the chunker. Up to one partial frame (256 ms at
 * 16 kHz) still in the worklet when the session stops is dropped, as with
 * the previous ScriptProcessorNode buffer.
 *
 * The node may have one or two inputs. With one, each message is a bare
 * `Float32Array`. With two (microphone and loopback), both are cut from
 * the same render quanta and posted together as `{ lanes: [a, b] }`, so
 * the lanes are sample-aligned by construction; an input with nothing
 * connected contributes silence.
 *
 * It is a string because Obsidian plugins ship as a single bundled file with
 * nothing to serve a worklet script from; the panel loads it via a blob: URL.
 * Only ES2018 syntax is used so the worklet scope needs no transpiling.
 */
export const CAPTURE_WORKLET_SOURCE = `
const FRAME_SAMPLES = ${CAPTURE_FRAME_SAMPLES};

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = null;
    this.filled = 0;
  }

  process(inputs) {
    if (inputs.length === 0) return true;
    if (!this.frames || this.frames.length !== inputs.length) {
      this.frames = inputs.map(() => new Float32Array(FRAME_SAMPLES));
      this.filled = 0;
    }
    let length = 0;
    for (const input of inputs) {
      if (input && input[0]) { length = input[0].length; break; }
    }
    if (length === 0) return true;
    let offset = 0;
    while (offset < length) {
      const n = Math.min(length - offset, FRAME_SAMPLES - this.filled);
      for (let i = 0; i < inputs.length; i++) {
        const channel = inputs[i] && inputs[i][0];
        if (channel) {
          this.frames[i].set(channel.subarray(offset, offset + n), this.filled);
        }
      }
      this.filled += n;
      offset += n;
      if (this.filled === FRAME_SAMPLES) {
        const frames = this.frames;
        if (frames.length === 1) {
          this.port.postMessage(frames[0], [frames[0].buffer]);
        } else {
          this.port.postMessage({ lanes: frames }, frames.map((f) => f.buffer));
        }
        this.frames = inputs.map(() => new Float32Array(FRAME_SAMPLES));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, CaptureProcessor);
`;

// ---------------------------------------------------------------------------
// Minimal structural interfaces for the Web Audio / MediaStream surface the
// session touches. The real DOM types satisfy these structurally, and tests
// can substitute fakes without a DOM.
// ---------------------------------------------------------------------------

export interface LiveMediaStreamTrackLike {
  enabled: boolean;
  readonly readyState: "live" | "ended";
  stop(): void;
  onended: ((...args: unknown[]) => void) | null;
}

export interface LiveMediaStreamLike {
  getTracks(): LiveMediaStreamTrackLike[];
  getAudioTracks(): LiveMediaStreamTrackLike[];
  getVideoTracks(): LiveMediaStreamTrackLike[];
}

export interface LiveAudioNodeLike {
  connect(destination: unknown, output?: number, input?: number): void;
  disconnect(): void;
}

/** The capture node's message port; each frame arrives as `event.data`. */
export interface LiveCapturePortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface LiveCaptureNodeLike extends LiveAudioNodeLike {
  readonly port: LiveCapturePortLike;
}

export interface LiveAudioContextLike {
  createMediaStreamSource(stream: LiveMediaStreamLike): LiveAudioNodeLike;
  readonly destination: unknown;
  close(): Promise<void>;
}

/** Injected factories so the session never touches `navigator` directly. */
export interface LiveCaptureDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<LiveMediaStreamLike>;
  getDisplayMedia(constraints: MediaStreamConstraints): Promise<LiveMediaStreamLike>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  createAudioContext(sampleRate: number): LiveAudioContextLike;
  /**
   * Install the capture worklet (`CAPTURE_WORKLET_SOURCE`, registered as
   * `CAPTURE_PROCESSOR_NAME`) in `context` with `numberOfInputs` inputs and
   * return a node for it. The node's port posts one message per captured
   * frame: a `Float32Array` for one input, `{ lanes: Float32Array[] }` for two.
   */
  createCaptureNode(
    context: LiveAudioContextLike,
    numberOfInputs: number,
  ): Promise<LiveCaptureNodeLike>;
}

export interface LiveRecordingSessionOptions {
  /** Seconds of audio per transcription chunk (default 15). */
  chunkSeconds?: number;
  /** Seconds of overlap between chunks (default 0.5). */
  overlapSeconds?: number;
  sampleRate?: number;
  /**
   * Called with each full window of 16 kHz mono PCM in arrival order: one
   * chunk per lane, all cut from the same samples.
   */
  onWindow: (window: LiveWindow) => void;
  /**
   * Called with every captured frame before it is chunked; frames dropped
   * while paused never reach it, so audio written from here has exactly the
   * windows' timeline.
   */
  onFrame?: (frame: LiveFrame) => void;
  /** Called for unexpected in-session errors (e.g. the track ended). */
  onError: (error: Error) => void;
  /** Injectable clock (ms) for testability; defaults to Date.now. */
  clock?: () => number;
}

/**
 * One live recording session: owns the MediaStreams, the 16 kHz AudioContext
 * graph, and one chunker per lane. `pause()` suspends capture (frames are
 * dropped and the tracks are disabled) without ending the session; `stop()`
 * tears the graph down and returns the final partial window if it holds at
 * least one second of audio.
 */
export class LiveRecordingSession {
  private readonly deps: LiveCaptureDeps;
  private readonly chunkSeconds: number;
  private readonly overlapSeconds: number;
  private readonly sampleRate: number;
  private readonly onWindow: (window: LiveWindow) => void;
  private readonly onFrame: ((frame: LiveFrame) => void) | undefined;
  private readonly onError: (error: Error) => void;
  private readonly clock: () => number;

  private lanes: LiveLane[] = ["mixed"];
  private chunkers = new Map<LiveLane, LiveChunker>();
  private windowIndex = 0;
  private streams: LiveMediaStreamLike[] = [];
  private context: LiveAudioContextLike | null = null;
  private sourceNodes: LiveAudioNodeLike[] = [];
  private captureNode: LiveCaptureNodeLike | null = null;
  private starting = false;
  private recording = false;
  private paused = false;
  private startedAtMs = 0;
  private pausedAtMs = 0;
  private pausedTotalMs = 0;

  constructor(deps: LiveCaptureDeps, opts: LiveRecordingSessionOptions) {
    this.deps = deps;
    this.chunkSeconds = opts.chunkSeconds ?? 15;
    this.overlapSeconds = opts.overlapSeconds ?? 0.5;
    this.sampleRate = opts.sampleRate ?? LIVE_SAMPLE_RATE;
    this.onWindow = opts.onWindow;
    this.onFrame = opts.onFrame;
    this.onError = opts.onError;
    this.clock = opts.clock ?? (() => Date.now());
    this.resetChunkers(["mixed"]);
  }

  private resetChunkers(lanes: LiveLane[]): void {
    this.lanes = lanes;
    this.chunkers = new Map(
      lanes.map((lane) => [
        lane,
        new LiveChunker({
          sampleRate: this.sampleRate,
          chunkSeconds: this.chunkSeconds,
          overlapSeconds: this.overlapSeconds,
        }),
      ]),
    );
    this.windowIndex = 0;
  }

  isRecording(): boolean {
    return this.recording;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** The lanes this session captures: `["mixed"]`, or `["me", "others"]`. */
  getLanes(): LiveLane[] {
    return [...this.lanes];
  }

  /**
   * Acquire the audio stream(s) and start the capture graph.
   *
   * - `"microphone"`: `getUserMedia` (optionally pinned to `deviceId`).
   * - `"system"`: if a specific input device is selected (a loopback device
   *   such as BlackHole / Stereo Mix / a PulseAudio monitor), capture it via
   *   `getUserMedia`. Otherwise attempt `getDisplayMedia({ video, audio })`
   *   and use its audio track when the platform provides one; when it does
   *   not, throw a descriptive error so the caller can direct the user to a
   *   loopback device. The microphone is never used as a silent fallback.
   * - `"both"`: the microphone (`micDeviceId`) as the `me` lane and the
   *   system source (`deviceId`, as above) as the `others` lane, through one
   *   two-input worklet so the lanes stay sample-aligned.
   */
  async start(
    source: LiveAudioSource,
    deviceId?: string,
    micDeviceId?: string,
  ): Promise<void> {
    if (this.recording || this.starting) {
      throw new Error("A live recording session is already active.");
    }
    // Set before the first await so a concurrent start() is refused while
    // the stream and the capture graph are still being set up.
    this.starting = true;
    try {
      await this.startCapture(source, deviceId, micDeviceId);
    } finally {
      this.starting = false;
    }
  }

  private async acquireStream(
    source: "microphone" | "system",
    deviceId?: string,
  ): Promise<LiveMediaStreamLike> {
    if (source === "system" && deviceId) {
      // A loopback input device is an ordinary audioinput on the OS.
      return this.deps.getUserMedia({
        audio: { deviceId: { exact: deviceId }, ...LOOPBACK_AUDIO_PROCESSING },
        video: false,
      });
    }
    if (source === "system") {
      let displayStream: LiveMediaStreamLike | null = null;
      try {
        displayStream = await this.deps.getDisplayMedia({
          video: true,
          audio: true,
        });
      } catch {
        displayStream = null; // user declined the share prompt
      }
      if (
        displayStream === null ||
        displayStream.getAudioTracks().length === 0
      ) {
        for (const track of displayStream?.getTracks() ?? []) track.stop();
        throw new Error(
          `${SYSTEM_AUDIO_UNAVAILABLE}: screen sharing did not provide an ` +
            `audio track. Select a loopback input device in the "Input device" ` +
            `dropdown instead (e.g. BlackHole on macOS, Stereo Mix or VB-CABLE ` +
            `on Windows, a PulseAudio/PipeWire monitor source on Linux). The ` +
            `microphone is not used as a fallback.`,
        );
      }
      // Keep only the audio track; we do not use the shared video.
      for (const track of displayStream.getVideoTracks()) track.stop();
      return displayStream;
    }
    return this.deps.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
  }

  private async startCapture(
    source: LiveAudioSource,
    deviceId?: string,
    micDeviceId?: string,
  ): Promise<void> {
    const lanes = lanesForSource(source);
    const streams: LiveMediaStreamLike[] = [];
    const stopStreams = () => {
      for (const stream of streams) {
        for (const track of stream.getTracks()) track.stop();
      }
    };
    try {
      if (source === "both") {
        streams.push(await this.acquireStream("microphone", micDeviceId));
        streams.push(await this.acquireStream("system", deviceId));
      } else {
        streams.push(await this.acquireStream(source, deviceId));
      }
    } catch (e) {
      // The microphone may already be live when the loopback fails.
      stopStreams();
      throw e;
    }

    // The streams are live from here on. If the session cannot start,
    // release them (so the OS recording indicator goes off) and whatever
    // part of the graph exists, then fail with `reason`.
    let context: LiveAudioContextLike | null = null;
    const abort = async (reason: Error): Promise<never> => {
      stopStreams();
      await context?.close().catch(() => undefined);
      throw reason;
    };

    let sourceNodes: LiveAudioNodeLike[] = [];
    let captureNode: LiveCaptureNodeLike;
    try {
      context = this.deps.createAudioContext(this.sampleRate);
      captureNode = await this.deps.createCaptureNode(context, lanes.length);
      captureNode.port.onmessage = (event) => this.handleMessage(event.data);
      const ctx = context;
      sourceNodes = streams.map((stream) => ctx.createMediaStreamSource(stream));
      sourceNodes.forEach((node, input) => node.connect(captureNode, 0, input));
      // Chromium only renders a worklet node that reaches the destination;
      // the processor writes no output, so nothing is audible.
      captureNode.connect(context.destination);
    } catch (e) {
      return abort(e as Error);
    }

    // Installing the worklet is asynchronous; a track that ended meanwhile
    // fired its one-shot `ended` event before any handler was attached.
    const ended = streams.some((stream) =>
      stream.getAudioTracks().some((track) => track.readyState === "ended"),
    );
    if (ended) {
      return abort(new Error("The audio input ended before recording started."));
    }

    // If the OS revokes a stream mid-session (e.g. device unplugged),
    // surface it and tear down.
    for (const stream of streams) {
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (!this.recording) return;
          this.onError(new Error("The audio input ended unexpectedly."));
        };
      }
    }

    this.resetChunkers(lanes);
    this.streams = streams;
    this.context = context;
    this.sourceNodes = sourceNodes;
    this.captureNode = captureNode;
    this.recording = true;
    this.paused = false;
    this.startedAtMs = this.clock();
    this.pausedAtMs = 0;
    this.pausedTotalMs = 0;
  }

  /**
   * Suspend capture: incoming frames are dropped and the tracks are
   * disabled (so the OS recording indicator reflects the pause). Samples
   * already buffered in the chunkers are kept; chunking continues on resume.
   */
  pause(): void {
    if (!this.recording || this.paused) return;
    this.paused = true;
    this.pausedAtMs = this.clock();
    for (const stream of this.streams) {
      for (const track of stream.getTracks()) track.enabled = false;
    }
  }

  /** Resume a paused session. */
  resume(): void {
    if (!this.recording || !this.paused) return;
    this.pausedTotalMs += this.clock() - this.pausedAtMs;
    this.paused = false;
    for (const stream of this.streams) {
      for (const track of stream.getTracks()) track.enabled = true;
    }
  }

  /**
   * End the session: tear down the graph, stop the tracks, close the
   * context, and return the final partial window (when it holds at least
   * one second of audio) so the caller can transcribe it.
   */
  async stop(): Promise<LiveWindow | null> {
    if (!this.recording) return null;
    this.recording = false;
    if (this.paused) {
      this.pausedTotalMs += this.clock() - this.pausedAtMs;
      this.paused = false;
    }

    const tail = this.flushWindow();

    const captureNode = this.captureNode;
    this.captureNode = null;
    this.sourceNodes = [];
    if (captureNode) {
      captureNode.port.onmessage = null;
      captureNode.port.close();
      try {
        captureNode.disconnect();
      } catch {
        // already disconnected
      }
    }
    const streams = this.streams;
    this.streams = [];
    for (const stream of streams) {
      for (const track of stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
    }
    const context = this.context;
    this.context = null;
    if (context) {
      try {
        await context.close();
      } catch {
        // already closed
      }
    }
    return tail;
  }

  /** Accumulated unpaused capture time in seconds (for the UI timer). */
  elapsedSeconds(): number {
    if (!this.recording) return 0;
    const now = this.paused ? this.pausedAtMs : this.clock();
    return Math.max(0, (now - this.startedAtMs - this.pausedTotalMs) / 1000);
  }

  private makeWindow(lanes: LiveFrame): LiveWindow {
    const index = this.windowIndex++;
    const step = this.chunkers.get(this.lanes[0])?.stepSamples ?? 0;
    return { index, startSeconds: (index * step) / this.sampleRate, lanes };
  }

  /** The lanes' remaining samples as one last window, or null when too short. */
  private flushWindow(): LiveWindow | null {
    const lanes: LiveFrame = {};
    let any = false;
    for (const lane of this.lanes) {
      const out = this.chunkers.get(lane)?.flush() ?? null;
      if (out) {
        lanes[lane] = out;
        any = true;
      }
    }
    return any ? this.makeWindow(lanes) : null;
  }

  /**
   * The lanes carried by one port message: a bare `Float32Array` for a
   * single-lane session, `{ lanes: [me, others] }` for a two-lane one.
   * Anything else (a message posted before the graph settled, say) is
   * ignored.
   */
  private frameFromMessage(data: unknown): LiveFrame | null {
    if (this.lanes.length === 1) {
      return data instanceof Float32Array ? { [this.lanes[0]]: data } : null;
    }
    const lanes =
      typeof data === "object" && data !== null
        ? (data as { lanes?: unknown }).lanes
        : undefined;
    if (
      !Array.isArray(lanes) ||
      lanes.length !== this.lanes.length ||
      !lanes.every((lane) => lane instanceof Float32Array)
    ) {
      return null;
    }
    const frame: LiveFrame = {};
    this.lanes.forEach((lane, i) => {
      frame[lane] = lanes[i] as Float32Array;
    });
    return frame;
  }

  private handleMessage(data: unknown): void {
    if (!this.recording || this.paused) return;
    const frame = this.frameFromMessage(data);
    if (!frame) return;
    this.onFrame?.(frame);
    // Every lane receives the same number of samples, so the chunkers emit
    // the same number of chunks and chunk k of each lane forms window k.
    const perLane = this.lanes.map(
      (lane) => this.chunkers.get(lane)?.push(frame[lane] ?? new Float32Array(0)) ?? [],
    );
    const count = Math.min(...perLane.map((chunks) => chunks.length));
    for (let i = 0; i < count; i++) {
      const lanes: LiveFrame = {};
      this.lanes.forEach((lane, l) => {
        lanes[lane] = perLane[l][i];
      });
      this.onWindow(this.makeWindow(lanes));
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin-wide single-session coordination
// ---------------------------------------------------------------------------

/**
 * Anything that can report whether its live capture is currently running
 * (the recording modal satisfies this structurally).
 */
export interface LiveSessionOwner {
  isRecording(): boolean;
}

/**
 * Tracks the single live recording session allowed across the whole plugin.
 * Framework-free so the coordination rule stays unit-testable: at most one
 * owner may hold the slot at a time, including while capture is starting;
 * `release` only clears the slot if the releasing owner still holds it.
 */
export class LiveSessionRegistry {
  private active: LiveSessionOwner | null = null;

  /** True when the current owner has started recording. */
  isRecording(): boolean {
    return this.active !== null && this.active.isRecording();
  }

  /**
   * Claim the single active slot. Returns false (without claiming) when
   * another owner already holds it; the caller must refuse with a Notice.
   */
  tryClaim(owner: LiveSessionOwner): boolean {
    if (this.active !== null && this.active !== owner) return false;
    this.active = owner;
    return true;
  }

  /** Release the slot, but only if `owner` still holds it. */
  release(owner: LiveSessionOwner): void {
    if (this.active === owner) this.active = null;
  }
}

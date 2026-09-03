import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Offline recognizer config for the NeMo Parakeet TDT 0.6B v2 (int8) model.
 *
 * Key names verified against the installed `sherpa-onnx-node` package
 * (types.js): the offline transducer lives under `modelConfig.transducer`
 * (NOT `offlineTransducer`), and feature config is `featConfig`.
 */
export interface RecognizerConfig {
  featConfig: {
    sampleRate: number;
    featureDim: number;
  };
  modelConfig: {
    transducer: {
      encoder: string;
      decoder: string;
      joiner: string;
    };
    tokens: string;
    numThreads: number;
    debug: boolean;
    provider: string;
  };
}

/** Expected file names inside the model directory. */
export const MODEL_FILE_NAMES = {
  encoder: "encoder.int8.onnx",
  decoder: "decoder.int8.onnx",
  joiner: "joiner.int8.onnx",
  tokens: "tokens.txt",
} as const;

export type ModelFileName = keyof typeof MODEL_FILE_NAMES;

/**
 * Absolute-ish paths (relative to the vault root) for each model file.
 * Pure so it can be unit-tested.
 */
export function modelFilePaths(
  modelDir: string,
): Record<ModelFileName, string> {
  const dir = modelDir.replace(/\/+$/, "");
  return {
    encoder: `${dir}/${MODEL_FILE_NAMES.encoder}`,
    decoder: `${dir}/${MODEL_FILE_NAMES.decoder}`,
    joiner: `${dir}/${MODEL_FILE_NAMES.joiner}`,
    tokens: `${dir}/${MODEL_FILE_NAMES.tokens}`,
  };
}

/**
 * Build the sherpa-onnx-node OfflineRecognizer config for a model directory.
 * Kept isolated so the (rare) config-key fix is a one-function change.
 */
export function buildRecognizerConfig(modelDir: string): RecognizerConfig {
  const paths = modelFilePaths(modelDir);
  return {
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      },
      tokens: paths.tokens,
      numThreads: 4,
      debug: false,
      provider: "cpu",
    },
  };
}

/**
 * Return the list of expected model files that are missing, given a
 * predicate that reports whether a path exists. Pure so it can be tested.
 */
export function missingModelFiles(
  modelDir: string,
  exists: (path: string) => boolean,
): string[] {
  const paths = modelFilePaths(modelDir);
  return (Object.keys(paths) as ModelFileName[])
    .map((k) => paths[k])
    .filter((p) => !exists(p));
}

/**
 * Load sherpa-onnx-node relative to the installed plugin directory. Obsidian
 * evaluates plugin code without a module directory context, so anchoring a
 * require at the plugin package makes Node find the plugin's node_modules.
 * Kept lazy so importing this module never loads the native addon.
 */
export function loadSherpaOnnx(pluginDir: string): any {
  const dir = pluginDir.replace(/\/+$/, "");
  const pluginRequire = createRequire(`${dir}/package.json`);
  return pluginRequire("sherpa-onnx-node");
}

// ---------------------------------------------------------------------------
// Recognizer holder
// ---------------------------------------------------------------------------

/**
 * The slice of sherpa-onnx-node's `OfflineRecognizer` / `OfflineStream` this
 * module uses, typed structurally so nothing here imports the addon's types.
 */
export interface OfflineStreamLike {
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
}

/**
 * The fields of sherpa-onnx's offline recognition result this module reads.
 * `tokens` are SentencePiece pieces (a piece that starts with a space or
 * "\u2581" begins a word) and `timestamps` their start times in seconds,
 * relative to the audio handed to the stream; `durations` is empty for the
 * Parakeet TDT export. All are optional: a fake or older addon may return
 * `{ text }` only.
 */
export interface OfflineRecognitionResultLike {
  text?: string;
  tokens?: string[];
  timestamps?: number[];
  durations?: number[];
}

export interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike;
  decodeAsync(
    stream: OfflineStreamLike,
  ): Promise<OfflineRecognitionResultLike | null | undefined>;
}

/** One recognized word with its time span in seconds. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** Transcript text plus the words it was assembled from (empty when the
 * recognizer reported no timestamps). */
export interface StructuredTranscript {
  text: string;
  words: TimedWord[];
}

interface RecognizerHolder {
  key: string;
  recognizer: Promise<OfflineRecognizerLike>;
}

/** The one wording for a missing-model-files notice or error. */
export function missingModelFilesMessage(missing: string[]): string {
  return (
    "Parakeet model files are missing: " +
    missing.join(", ") +
    ". Run the 'Download Parakeet model' command first."
  );
}

/**
 * Thrown when the model directory lacks one or more of the expected files.
 * The message already carries the user-facing guidance, so callers can show
 * it as is; `missing` lists the absent paths.
 */
export class ModelFilesMissingError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(missingModelFilesMessage(missing));
    this.name = "ModelFilesMissingError";
    this.missing = missing;
  }
}

/**
 * The single process-wide recognizer. Loading the three ONNX models takes
 * seconds and hundreds of MB of native memory, so it is created once and
 * shared; sherpa-onnx's offline recognizer may be used from several callers
 * at once (CPU provider) as long as each decode uses its own stream.
 */
let holder: RecognizerHolder | null = null;

function recognizerKey(modelDir: string, pluginDir: string): string {
  return `${pluginDir.replace(/\/+$/, "")}\n${modelDir.replace(/\/+$/, "")}`;
}

/**
 * Return the recognizer for `modelDir`, creating it on first use via
 * `OfflineRecognizer.createAsync` (model loading runs off the main thread)
 * and reusing it afterwards. Only one recognizer is held at a time: asking
 * for a different model or plugin directory drops the previous one.
 *
 * The model files are re-checked on every call. A deleted or moved model
 * therefore surfaces as a clear error and drops the stale recognizer instead
 * of silently keeping the old model in memory. A failed creation is not
 * cached, so the next call retries.
 */
export async function getRecognizer(
  modelDir: string,
  pluginDir: string,
): Promise<OfflineRecognizerLike> {
  const missing = missingModelFiles(modelDir, existsSync);
  if (missing.length > 0) {
    holder = null;
    throw new ModelFilesMissingError(missing);
  }

  const key = recognizerKey(modelDir, pluginDir);
  if (holder === null || holder.key !== key) {
    const sherpa = loadSherpaOnnx(pluginDir);
    const recognizer: Promise<OfflineRecognizerLike> =
      sherpa.OfflineRecognizer.createAsync(buildRecognizerConfig(modelDir));
    holder = { key, recognizer };
    recognizer.catch(() => {
      // Forget a failed creation so the next call retries, unless a newer
      // holder has replaced it meanwhile.
      if (holder?.recognizer === recognizer) holder = null;
    });
  }
  return holder.recognizer;
}

/**
 * Drop the cached recognizer. sherpa-onnx-node exposes no dispose(), so the
 * native memory is reclaimed when the addon finalizes the handle after GC;
 * dropping the only long-lived JS reference is all a caller can do. Used on
 * plugin unload and before a model download overwrites the files in place
 * (the cache key cannot tell new files from old). A decode already in flight
 * is unaffected: the wrapper's pending promise keeps the native handles
 * alive until it settles.
 */
export function releaseRecognizer(): void {
  holder = null;
}

// ---------------------------------------------------------------------------
// Words and timestamps
// ---------------------------------------------------------------------------

/**
 * Group the recognizer's SentencePiece tokens into words with a time span
 * each. A piece that begins with a space or "▁" starts a word; any other
 * piece (a suffix, punctuation, an apostrophe) extends the current one. The
 * start is the first piece's timestamp. Parakeet's export reports no
 * durations, so a word ends where the next word starts, capped at
 * `maxWordSeconds` so a long pause is not counted as speech, and at
 * `totalSeconds` for the last word. When durations are present they win.
 *
 * Returns `[]` when the arrays are absent or inconsistent: the transcript text
 * is still usable, only speaker alignment is not. Pure so it can be tested.
 */
export function wordsFromTokens(
  tokens: readonly string[] | undefined,
  timestamps: readonly number[] | undefined,
  durations: readonly number[] | undefined,
  totalSeconds: number,
  maxWordSeconds = 1,
): TimedWord[] {
  if (!tokens || !timestamps) return [];
  if (tokens.length === 0 || tokens.length !== timestamps.length) return [];
  const hasDurations =
    durations !== undefined && durations.length === tokens.length;

  interface Group {
    text: string;
    start: number;
    last: number;
  }
  const groups: Group[] = [];
  // A piece that is only a space carries no text but still marks a boundary.
  let pendingBoundary = false;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i] ?? "";
    const marksBoundary = /^[ ▁]/.test(raw);
    const piece = raw.replace(/^[ ▁]+/, "");
    if (piece.length === 0) {
      pendingBoundary = pendingBoundary || marksBoundary;
      continue;
    }
    const startsWord = marksBoundary || pendingBoundary;
    pendingBoundary = false;
    const current = groups[groups.length - 1];
    if (startsWord || !current) {
      groups.push({ text: piece, start: timestamps[i], last: i });
    } else {
      current.text += piece;
      current.last = i;
    }
  }

  const words: TimedWord[] = [];
  for (let g = 0; g < groups.length; g++) {
    const { text, start, last } = groups[g];
    const nextStart = g + 1 < groups.length ? groups[g + 1].start : Infinity;
    const duration = hasDurations ? durations[last] : 0;
    let end =
      duration > 0
        ? timestamps[last] + duration
        : Math.min(nextStart, start + maxWordSeconds);
    if (Number.isFinite(totalSeconds)) end = Math.min(end, totalSeconds);
    if (!(end >= start)) end = start;
    words.push({ text, start, end });
  }
  return words;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

async function decode(
  pcm: Float32Array,
  modelDir: string,
  pluginDir: string,
  sampleRate: number,
): Promise<OfflineRecognitionResultLike | null | undefined> {
  const recognizer = await getRecognizer(modelDir, pluginDir);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: pcm, sampleRate });
  return recognizer.decodeAsync(stream);
}

/**
 * Transcribe 16 kHz mono PCM samples into text using the Parakeet model in
 * `modelDir`.
 *
 * The recognizer is created once and cached (see `getRecognizer`), and the
 * decode runs on a libuv worker via `decodeAsync`, so neither model loading
 * nor decoding blocks the Electron renderer thread — the live panel calls
 * this once per chunk while audio capture continues.
 *
 * The native addon is loaded lazily via a require anchored at `pluginDir`
 * (and remains an esbuild external), so importing this module never loads the
 * native binary — important for headless vitest runs. If the host's
 * Electron/Node ABI rejects the prebuilt addon, a fallback is to spawn
 * `process.execPath` with ELECTRON_RUN_AS_NODE=1 and a small helper script
 * that performs this same decode; see the README.
 */
export async function transcribe(
  pcm: Float32Array,
  modelDir: string,
  pluginDir: string,
  sampleRate = 16000,
): Promise<string> {
  const result = await decode(pcm, modelDir, pluginDir, sampleRate);
  return (result?.text ?? "").trim();
}

/**
 * Like `transcribe`, but also returns the words with their time spans (see
 * `wordsFromTokens`), relative to the start of `pcm`. The speaker pass aligns
 * these against diarization segments; the text itself is the recognizer's
 * own, unchanged.
 */
export async function transcribeWithTimestamps(
  pcm: Float32Array,
  modelDir: string,
  pluginDir: string,
  sampleRate = 16000,
): Promise<StructuredTranscript> {
  const result = await decode(pcm, modelDir, pluginDir, sampleRate);
  const text = (result?.text ?? "").trim();
  const words = wordsFromTokens(
    result?.tokens,
    result?.timestamps,
    result?.durations,
    pcm.length / sampleRate,
  );
  return { text, words };
}

// ---------------------------------------------------------------------------
// Long audio
// ---------------------------------------------------------------------------

/**
 * Boundaries for decoding long audio in windows of at most `maxSeconds`:
 * `[0, cut1, cut2, …, pcm.length]`. Each cut lands on the quietest 100 ms
 * (lowest energy, 20 ms hop) within the `searchSeconds` before the window
 * limit, so a window rarely ends mid-word and the windows need no overlap.
 * Parakeet's full attention is quadratic in the input length, which is why
 * an hour-long recording is not decoded in one pass. Pure so it can be tested.
 */
export function splitAtQuietPoints(
  pcm: Float32Array,
  sampleRate: number,
  maxSeconds = 600,
  searchSeconds = 15,
): number[] {
  const maxSamples = Math.max(1, Math.floor(maxSeconds * sampleRate));
  const searchSamples = Math.max(0, Math.floor(searchSeconds * sampleRate));
  const rmsWindow = Math.max(1, Math.round(0.1 * sampleRate));
  const hop = Math.max(1, Math.round(0.02 * sampleRate));

  const bounds = [0];
  let offset = 0;
  while (pcm.length - offset > maxSamples) {
    const target = offset + maxSamples;
    const from = Math.max(offset + 1, target - searchSamples);
    let bestCut = target;
    let bestEnergy = Infinity;
    for (let s = from; s + rmsWindow <= target; s += hop) {
      let energy = 0;
      for (let i = s; i < s + rmsWindow; i++) energy += pcm[i] * pcm[i];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestCut = s + (rmsWindow >> 1);
      }
    }
    bounds.push(bestCut);
    offset = bestCut;
  }
  bounds.push(pcm.length);
  return bounds;
}

export interface LongTranscribeOptions {
  /** Longest window decoded in one pass (default 600 s). */
  maxSeconds?: number;
  /** How far before the window limit to look for a quiet cut (default 15 s). */
  searchSeconds?: number;
  /** Called after each window: windows done so far, and the total. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * `transcribeWithTimestamps` over `splitAtQuietPoints` windows, with word
 * times shifted to the whole recording and the window texts joined by a
 * space. Used when a whole recording (a kept live WAV, a long file) must be
 * re-transcribed with timestamps.
 */
export async function transcribeLongWithTimestamps(
  pcm: Float32Array,
  modelDir: string,
  pluginDir: string,
  sampleRate = 16000,
  opts: LongTranscribeOptions = {},
): Promise<StructuredTranscript> {
  const bounds = splitAtQuietPoints(
    pcm,
    sampleRate,
    opts.maxSeconds,
    opts.searchSeconds,
  );
  const total = bounds.length - 1;
  const texts: string[] = [];
  const words: TimedWord[] = [];
  for (let w = 0; w < total; w++) {
    const from = bounds[w];
    const to = bounds[w + 1];
    if (to > from) {
      // A copy rather than a subarray view: the native addon reads the
      // typed array from its own start.
      const part = await transcribeWithTimestamps(
        pcm.slice(from, to),
        modelDir,
        pluginDir,
        sampleRate,
      );
      const offset = from / sampleRate;
      if (part.text) texts.push(part.text);
      for (const word of part.words) {
        words.push({
          text: word.text,
          start: word.start + offset,
          end: word.end + offset,
        });
      }
    }
    opts.onProgress?.(w + 1, total);
  }
  return { text: texts.join(" "), words };
}

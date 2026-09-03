import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { SpeakerSegment } from "./speakers";
import { loadSherpaOnnx } from "./transcriber";

// ---------------------------------------------------------------------------
// Model files
// ---------------------------------------------------------------------------

/** Expected file names inside the diarization model directory. */
export const DIARIZATION_MODEL_FILE_NAMES = {
  segmentation: "pyannote-segmentation-3-0.int8.onnx",
  embedding: "nemo_en_titanet_small.onnx",
} as const;

export type DiarizationModelFileName = keyof typeof DIARIZATION_MODEL_FILE_NAMES;

/**
 * Paths (relative to wherever `modelDir` is anchored) of each diarization
 * model file. Pure so it can be unit-tested; the trailing-slash strip keeps
 * `dir` and `dir/` from producing different paths and cache keys.
 */
export function diarizationModelFilePaths(
  modelDir: string,
): Record<DiarizationModelFileName, string> {
  const dir = modelDir.replace(/\/+$/, "");
  return {
    segmentation: `${dir}/${DIARIZATION_MODEL_FILE_NAMES.segmentation}`,
    embedding: `${dir}/${DIARIZATION_MODEL_FILE_NAMES.embedding}`,
  };
}

/**
 * Return the expected diarization model files that are missing, given a
 * predicate that reports whether a path exists. Pure so it can be tested.
 */
export function missingDiarizationModelFiles(
  modelDir: string,
  exists: (path: string) => boolean,
): string[] {
  const paths = diarizationModelFilePaths(modelDir);
  return (Object.keys(paths) as DiarizationModelFileName[])
    .map((k) => paths[k])
    .filter((p) => !exists(p));
}

/** The one wording for a missing-diarization-files notice or error. */
export function missingDiarizationModelFilesMessage(missing: string[]): string {
  return (
    "Diarization model files are missing: " +
    missing.join(", ") +
    ". Run the 'Download diarization models' command first."
  );
}

/**
 * Thrown when the model directory lacks one or both diarization models. The
 * message already carries the user-facing guidance, so callers can show it as
 * is; `missing` lists the absent paths.
 */
export class DiarizationModelFilesMissingError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(missingDiarizationModelFilesMessage(missing));
    this.name = "DiarizationModelFilesMissingError";
    this.missing = missing;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Sample rate the bundled pyannote/titanet models were trained at. */
export const DIARIZATION_SAMPLE_RATE = 16000;

/**
 * Threads per model. Two models run back to back and the transcriber already
 * claims four threads for its own decode, so keep diarization modest to avoid
 * starving the renderer while both are busy.
 */
const DEFAULT_NUM_THREADS = 2;

export interface DiarizationOptions {
  /** 0 = detect the speaker count automatically via `threshold`; > 0 is the exact count. */
  numSpeakers: number;
  /** Clustering distance threshold, only consulted when `numSpeakers` is 0. */
  threshold: number;
  /** Threads per ONNX session; defaults to 2. */
  numThreads?: number;
}

export const DEFAULT_DIARIZATION_OPTIONS: DiarizationOptions = {
  numSpeakers: 0,
  threshold: 0.5,
};

/**
 * sherpa-onnx's `FastClusteringConfig`. `numClusters` is an exact count when
 * positive; `-1` tells the clusterer to decide from `threshold` instead.
 */
export interface FastClusteringConfig {
  numClusters: number;
  threshold: number;
}

/**
 * sherpa-onnx-node's `OfflineSpeakerDiarizationConfig`, key names verified
 * against the installed package (types.js). Optional markers mirror the
 * addon's own typedefs; `buildDiarizationConfig` fills every field anyway so
 * the native defaults never silently apply.
 */
export interface OfflineSpeakerDiarizationConfig {
  segmentation: {
    pyannote: {
      model: string;
      windowShiftRatio?: number;
    };
    numThreads?: number;
    provider?: string;
    debug?: boolean;
  };
  embedding: {
    model: string;
    numThreads?: number;
    provider?: string;
    debug?: boolean;
  };
  clustering: FastClusteringConfig;
  minDurationOn?: number;
  minDurationOff?: number;
}

/**
 * The clustering block derived from user options. Exported on its own so the
 * `setConfig` comparison in `diarize` and the initial config share one rule.
 */
export function clusteringConfig(opts: DiarizationOptions): FastClusteringConfig {
  return opts.numSpeakers > 0
    ? { numClusters: opts.numSpeakers, threshold: opts.threshold }
    : { numClusters: -1, threshold: opts.threshold };
}

/**
 * Build the sherpa-onnx-node OfflineSpeakerDiarization config for a model
 * directory. Kept isolated so a config-key fix is a one-function change.
 *
 * `windowShiftRatio` 0.1 is pyannote's default overlap; the min-duration
 * pair drops sub-300 ms blips and bridges sub-500 ms pauses so one speaker's
 * breath does not split a sentence into two segments.
 */
export function buildDiarizationConfig(
  modelDir: string,
  opts: DiarizationOptions,
): OfflineSpeakerDiarizationConfig {
  const paths = diarizationModelFilePaths(modelDir);
  const numThreads = opts.numThreads ?? DEFAULT_NUM_THREADS;
  return {
    segmentation: {
      pyannote: {
        model: paths.segmentation,
        windowShiftRatio: 0.1,
      },
      numThreads,
      provider: "cpu",
      debug: false,
    },
    embedding: {
      model: paths.embedding,
      numThreads,
      provider: "cpu",
      debug: false,
    },
    clustering: clusteringConfig(opts),
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  };
}

// ---------------------------------------------------------------------------
// Addon loading
// ---------------------------------------------------------------------------

/**
 * Load the raw native addon (`sherpa-onnx-node/addon.js`) relative to the
 * plugin directory, the same way `loadSherpaOnnx` loads the wrapper. The
 * package has no "exports" field, so the deep path resolves, and it is the
 * very module instance the wrapper classes use, so a wrapper's `.handle` is
 * valid for it. Needed because the wrapper class only exposes the blocking
 * `process`; the worker-thread `offlineSpeakerDiarizationProcessAsync` lives
 * on the addon alone. Lazy so importing this module never loads the binary.
 */
export function loadSherpaOnnxAddon(pluginDir: string): any {
  const dir = pluginDir.replace(/\/+$/, "");
  const pluginRequire = createRequire(`${dir}/package.json`);
  return pluginRequire("sherpa-onnx-node/addon.js");
}

// ---------------------------------------------------------------------------
// Diarizer holder
// ---------------------------------------------------------------------------

/**
 * The slice of sherpa-onnx-node's `OfflineSpeakerDiarization` this module
 * uses, typed structurally so nothing here imports the addon's types.
 */
export interface DiarizerLike {
  handle: unknown;
  sampleRate: number;
  setConfig(config: { clustering: FastClusteringConfig }): void;
  process(samples: Float32Array): SpeakerSegment[];
}

interface DiarizerHolder {
  key: string;
  diarizer: Promise<DiarizerLike>;
  /**
   * The clustering config the native handle currently carries. Tracked here
   * (not on the wrapper) so `diarize` can skip a redundant `setConfig` and
   * so the record dies with the handle it describes.
   */
  lastClustering: FastClusteringConfig;
}

/**
 * The single process-wide diarizer. The two ONNX models are ~42 MB of native
 * memory and take noticeable time to load, so one instance is created and
 * shared; sherpa-onnx's diarizer holds a single native handle, which is why
 * `diarize` serialises its callers instead of letting them overlap.
 */
let holder: DiarizerHolder | null = null;

function diarizerKey(modelDir: string, pluginDir: string): string {
  return `${pluginDir.replace(/\/+$/, "")}\n${modelDir.replace(/\/+$/, "")}`;
}

/**
 * Synchronous core of `getDiarizer`: check the files, then create or reuse
 * the holder. Returns the holder object itself so `diarize` can keep a
 * reference to the exact entry it is using, even if the module-level slot is
 * released or replaced while its (serialised) call is still in flight.
 */
function acquireHolder(modelDir: string, pluginDir: string): DiarizerHolder {
  const missing = missingDiarizationModelFiles(modelDir, existsSync);
  if (missing.length > 0) {
    holder = null;
    throw new DiarizationModelFilesMissingError(missing);
  }

  const key = diarizerKey(modelDir, pluginDir);
  if (holder === null || holder.key !== key) {
    const sherpa = loadSherpaOnnx(pluginDir);
    const config = buildDiarizationConfig(modelDir, DEFAULT_DIARIZATION_OPTIONS);
    // The constructor is synchronous (and blocks for the model load), but it
    // is wrapped in a promise so concurrent first callers share the one
    // construction and a throw becomes a rejection the catch below can forget.
    const diarizer: Promise<DiarizerLike> = Promise.resolve().then(
      () => new sherpa.OfflineSpeakerDiarization(config) as DiarizerLike,
    );
    const entry: DiarizerHolder = {
      key,
      diarizer,
      lastClustering: config.clustering,
    };
    holder = entry;
    diarizer.catch(() => {
      // Forget a failed creation so the next call retries, unless a newer
      // holder has replaced it meanwhile.
      if (holder === entry) holder = null;
    });
  }
  return holder;
}

/**
 * Return the diarizer for `modelDir`, creating it on first use and reusing
 * it afterwards. Only one diarizer is held at a time: asking for a different
 * model or plugin directory drops the previous one.
 *
 * The model files are re-checked on every call. A deleted or moved model
 * therefore surfaces as a clear error and drops the stale diarizer instead of
 * silently keeping the old models in memory. A failed creation is not cached,
 * so the next call retries.
 */
export async function getDiarizer(
  modelDir: string,
  pluginDir: string,
): Promise<DiarizerLike> {
  return acquireHolder(modelDir, pluginDir).diarizer;
}

/**
 * Drop the cached diarizer. sherpa-onnx-node exposes no dispose(), so the
 * native memory is reclaimed when the addon finalizes the handle after GC;
 * dropping the only long-lived JS reference is all a caller can do. Used on
 * plugin unload and before a model download overwrites the files in place
 * (the cache key cannot tell new files from old). A diarization already in
 * flight is unaffected: it holds its own reference to the entry until it
 * settles, and the serialising queue is deliberately left alone.
 */
export function releaseDiarizer(): void {
  holder = null;
}

// ---------------------------------------------------------------------------
// Diarize
// ---------------------------------------------------------------------------

export interface DiarizeProgress {
  processed: number;
  total: number;
}

/**
 * Tail of the serialising queue. Every `diarize` call chains onto it, and
 * the tail is always a settled-or-pending *resolved* promise (rejections are
 * absorbed when the tail is advanced) so one failed call cannot poison the
 * callers queued behind it.
 */
let queue: Promise<void> = Promise.resolve();

function sameClustering(a: FastClusteringConfig, b: FastClusteringConfig): boolean {
  return a.numClusters === b.numClusters && a.threshold === b.threshold;
}

/**
 * Copy the addon's segments into fresh plain objects sorted by time. The
 * native side groups results by speaker, and it may hand back objects backed
 * by its own buffers, so callers get a stable, independent, time-ordered list.
 */
function sortedSegments(raw: readonly SpeakerSegment[]): SpeakerSegment[] {
  return raw
    .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }))
    .sort(
      (a, b) => a.start - b.start || a.end - b.end || a.speaker - b.speaker,
    );
}

async function runDiarize(
  pcm: Float32Array,
  modelDir: string,
  pluginDir: string,
  opts: DiarizationOptions,
  onProgress: ((p: DiarizeProgress) => void) | undefined,
): Promise<SpeakerSegment[]> {
  const entry = acquireHolder(modelDir, pluginDir);
  const diarizer = await entry.diarizer;

  // The plugin captures and resamples to 16 kHz; a model exported at another
  // rate would silently mis-time every segment, so refuse rather than guess.
  if (diarizer.sampleRate !== DIARIZATION_SAMPLE_RATE) {
    throw new Error(
      `Diarization models expect ${diarizer.sampleRate} Hz audio, but the ` +
        `plugin supplies ${DIARIZATION_SAMPLE_RATE} Hz PCM.`,
    );
  }

  // setConfig rebuilds the clusterer on the native side; only pay for it
  // when the caller's options actually differ from what the handle holds.
  const clustering = clusteringConfig(opts);
  if (!sameClustering(entry.lastClustering, clustering)) {
    diarizer.setConfig({ clustering });
    entry.lastClustering = clustering;
  }

  const addon = loadSherpaOnnxAddon(pluginDir);
  let raw: SpeakerSegment[];
  if (typeof addon.offlineSpeakerDiarizationProcessAsync === "function") {
    // Runs on a libuv worker thread. The native binding demands exactly three
    // arguments, so a no-op progress function is passed even when the caller
    // did not ask for progress.
    raw = await addon.offlineSpeakerDiarizationProcessAsync(
      diarizer.handle,
      pcm,
      (processed: number, total: number) => {
        onProgress?.({ processed, total });
      },
    );
  } else {
    // Older addon without the async export: `process` BLOCKS the renderer for
    // the whole run (seconds per minute of audio). Kept as a fallback so an
    // ABI mismatch degrades to slow rather than broken.
    raw = diarizer.process(pcm);
  }
  return sortedSegments(raw);
}

/**
 * Split 16 kHz mono PCM into speaker-labelled time segments using the
 * pyannote + titanet models in `modelDir`.
 *
 * All calls are serialised through a module-level queue: sherpa-onnx's
 * diarizer is a single native handle, and `setConfig` followed by `process`
 * must never interleave with another caller's pair or one run would use the
 * other's clustering options. A rejected call releases the queue for the
 * next caller. When the addon exports the async entry point the work runs
 * on a libuv worker and reports progress in chunks; otherwise it falls back
 * to the blocking `process`.
 *
 * Returned segments are fresh plain objects sorted by start, then end, then
 * speaker id, regardless of the speaker-grouped order the addon produces.
 */
export async function diarize(
  pcm: Float32Array,
  modelDir: string,
  pluginDir: string,
  opts: DiarizationOptions = DEFAULT_DIARIZATION_OPTIONS,
  onProgress?: (p: DiarizeProgress) => void,
): Promise<SpeakerSegment[]> {
  const run = queue.then(() =>
    runDiarize(pcm, modelDir, pluginDir, opts, onProgress),
  );
  // Advance the tail past this run whether it succeeds or fails; the caller
  // still sees the rejection through `run` itself.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

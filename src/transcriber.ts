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

export interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike;
  decodeAsync(
    stream: OfflineStreamLike,
  ): Promise<{ text?: string } | null | undefined>;
}

interface RecognizerHolder {
  key: string;
  recognizer: Promise<OfflineRecognizerLike>;
}

/**
 * The single process-wide recognizer. Loading the three ONNX models takes
 * seconds and hundreds of MB of native memory, so it is created once and
 * shared; sherpa-onnx's offline recognizer may be used from several callers
 * at once as long as each decode uses its own stream.
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
  exists: (path: string) => boolean = existsSync,
): Promise<OfflineRecognizerLike> {
  const missing = missingModelFiles(modelDir, exists);
  if (missing.length > 0) {
    holder = null;
    throw new Error(`Parakeet model files are missing: ${missing.join(", ")}`);
  }

  const key = recognizerKey(modelDir, pluginDir);
  let entry = holder;
  if (entry === null || entry.key !== key) {
    const sherpa = loadSherpaOnnx(pluginDir);
    const recognizer: Promise<OfflineRecognizerLike> =
      sherpa.OfflineRecognizer.createAsync(buildRecognizerConfig(modelDir));
    const created: RecognizerHolder = { key, recognizer };
    holder = created;
    recognizer.catch(() => {
      if (holder === created) holder = null;
    });
    entry = created;
  }
  return entry.recognizer;
}

/**
 * Drop the cached recognizer. sherpa-onnx-node exposes no dispose(), so the
 * native memory is reclaimed when the addon finalizes the handle after GC;
 * dropping the only long-lived JS reference is all a caller can do. Used on
 * plugin unload and when the model directory setting changes. A transcribe()
 * already in flight keeps its own reference until its decode completes.
 */
export function releaseRecognizer(): void {
  holder = null;
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
  const recognizer = await getRecognizer(modelDir, pluginDir);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: pcm, sampleRate });
  const result = await recognizer.decodeAsync(stream);
  return (result?.text ?? "").trim();
}

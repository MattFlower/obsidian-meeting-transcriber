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
 * Transcribe 16 kHz mono PCM samples into text using the Parakeet model in
 * `modelDir`.
 *
 * The native addon is required lazily (and is an esbuild external) so that
 * importing this module never loads the native binary — important for the
 * headless vitest runs. If the host's Electron/Node ABI rejects the
 * prebuilt addon, a fallback is to spawn `process.execPath` with
 * ELECTRON_RUN_AS_NODE=1 and a small helper script that performs this same
 * decode; see the README.
 */
export async function transcribe(
  pcm: Float32Array,
  modelDir: string,
  sampleRate = 16000,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sherpa = require("sherpa-onnx-node");
  const recognizer = new sherpa.OfflineRecognizer(
    buildRecognizerConfig(modelDir),
  );
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: pcm, sampleRate });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    return (result?.text ?? "").trim();
  } finally {
    // Release the native handle if the addon exposes a dispose method.
    if (typeof recognizer.dispose === "function") {
      recognizer.dispose();
    }
  }
}

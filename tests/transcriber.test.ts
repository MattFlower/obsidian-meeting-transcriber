import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MODEL_FILE_NAMES,
  buildRecognizerConfig,
  loadSherpaOnnx,
  missingModelFiles,
  modelFilePaths,
  releaseRecognizer,
  transcribe,
} from "../src/transcriber";

/**
 * Fake `sherpa-onnx-node` installed under a temporary plugin directory. It
 * mirrors the async surface of the real wrapper (`OfflineRecognizer.createAsync`
 * and `decodeAsync`) and deliberately omits the synchronous `decode` /
 * `getResult` pair, so any regression to the blocking path fails loudly.
 */
const FAKE_SHERPA_SOURCE = `
let lastConfig;
let lastWaveform;
let constructed = 0;
let createdAsync = 0;
let failNextCreate = false;

class OfflineRecognizer {
  constructor(config) {
    constructed++;
    lastConfig = config;
  }
  static async createAsync(config) {
    createdAsync++;
    if (failNextCreate) {
      failNextCreate = false;
      throw new Error("createAsync failed");
    }
    return new OfflineRecognizer(config);
  }
  createStream() {
    return {
      acceptWaveform(waveform) {
        lastWaveform = waveform;
      },
    };
  }
  async decodeAsync(stream) {
    return { text: "  hello world  " };
  }
}

module.exports = {
  __fake: true,
  OfflineRecognizer,
  getLastConfig: () => lastConfig,
  getLastWaveform: () => lastWaveform,
  counts: () => ({ constructed, createdAsync }),
  failNextCreate: () => { failNextCreate = true; },
  reset: () => {
    lastConfig = undefined;
    lastWaveform = undefined;
    constructed = 0;
    createdAsync = 0;
    failNextCreate = false;
  },
};
`;

function writeModelFiles(modelDir: string): void {
  mkdirSync(modelDir, { recursive: true });
  for (const name of Object.values(MODEL_FILE_NAMES)) {
    writeFileSync(path.join(modelDir, name), "");
  }
}

describe("transcribe with the plugin-directory recognizer", () => {
  let pluginDir: string;
  let modelDir: string;
  let otherModelDir: string;
  const pcm = new Float32Array(16000);

  beforeAll(() => {
    pluginDir = mkdtempSync(path.join(tmpdir(), "plugin-dir-"));
    writeFileSync(path.join(pluginDir, "package.json"), "{}");

    const moduleDir = path.join(pluginDir, "node_modules", "sherpa-onnx-node");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      path.join(moduleDir, "package.json"),
      JSON.stringify({ main: "index.js" }),
    );
    writeFileSync(path.join(moduleDir, "index.js"), FAKE_SHERPA_SOURCE);

    modelDir = path.join(pluginDir, "models", "parakeet");
    otherModelDir = path.join(pluginDir, "models", "other");
    writeModelFiles(modelDir);
    writeModelFiles(otherModelDir);
  });

  afterAll(() => {
    releaseRecognizer();
    rmSync(pluginDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    releaseRecognizer();
    loadSherpaOnnx(pluginDir).reset();
  });

  it("loads sherpa-onnx-node from the installed plugin directory", () => {
    expect(loadSherpaOnnx(pluginDir).__fake).toBe(true);
  });

  it("constructs the recognizer once with createAsync and reuses it", async () => {
    const first = await transcribe(pcm, modelDir, pluginDir);
    const second = await transcribe(pcm, modelDir, pluginDir);

    expect(first).toBe("hello world");
    expect(second).toBe("hello world");
    const sherpa = loadSherpaOnnx(pluginDir);
    expect(sherpa.counts()).toEqual({ constructed: 1, createdAsync: 1 });
    expect(sherpa.getLastConfig().modelConfig.transducer.encoder).toBe(
      `${modelDir}/encoder.int8.onnx`,
    );
  });

  it("feeds the samples and sample rate to a fresh stream", async () => {
    await transcribe(pcm, modelDir, pluginDir, 16000);
    const waveform = loadSherpaOnnx(pluginDir).getLastWaveform();
    expect(waveform.samples).toBe(pcm);
    expect(waveform.sampleRate).toBe(16000);
  });

  it("shares one in-flight creation between concurrent calls", async () => {
    const texts = await Promise.all([
      transcribe(pcm, modelDir, pluginDir),
      transcribe(pcm, modelDir, pluginDir),
      transcribe(pcm, modelDir, pluginDir),
    ]);
    expect(texts).toEqual(["hello world", "hello world", "hello world"]);
    expect(loadSherpaOnnx(pluginDir).counts().createdAsync).toBe(1);
  });

  it("builds a new recognizer when the model directory changes", async () => {
    await transcribe(pcm, modelDir, pluginDir);
    await transcribe(pcm, otherModelDir, pluginDir);
    const sherpa = loadSherpaOnnx(pluginDir);
    expect(sherpa.counts().createdAsync).toBe(2);
    expect(sherpa.getLastConfig().modelConfig.tokens).toBe(
      `${otherModelDir}/tokens.txt`,
    );
    // Only one recognizer is held: switching back rebuilds again.
    await transcribe(pcm, modelDir, pluginDir);
    expect(sherpa.counts().createdAsync).toBe(3);
  });

  it("treats a trailing slash on the model directory as the same model", async () => {
    await transcribe(pcm, modelDir, pluginDir);
    await transcribe(pcm, `${modelDir}/`, pluginDir);
    expect(loadSherpaOnnx(pluginDir).counts().createdAsync).toBe(1);
  });

  it("releaseRecognizer() drops the cache so the next call rebuilds", async () => {
    await transcribe(pcm, modelDir, pluginDir);
    releaseRecognizer();
    await transcribe(pcm, modelDir, pluginDir);
    expect(loadSherpaOnnx(pluginDir).counts().createdAsync).toBe(2);
  });

  it("rejects and drops the cache when a model file goes missing", async () => {
    await transcribe(pcm, modelDir, pluginDir);
    const tokens = path.join(modelDir, MODEL_FILE_NAMES.tokens);
    unlinkSync(tokens);
    try {
      await expect(transcribe(pcm, modelDir, pluginDir)).rejects.toThrow(
        /missing: .*tokens\.txt/,
      );
    } finally {
      writeFileSync(tokens, "");
    }
    await transcribe(pcm, modelDir, pluginDir);
    expect(loadSherpaOnnx(pluginDir).counts().createdAsync).toBe(2);
  });

  it("does not cache a failed creation", async () => {
    const sherpa = loadSherpaOnnx(pluginDir);
    sherpa.failNextCreate();
    await expect(transcribe(pcm, modelDir, pluginDir)).rejects.toThrow(
      "createAsync failed",
    );
    expect(await transcribe(pcm, modelDir, pluginDir)).toBe("hello world");
    expect(sherpa.counts()).toEqual({ constructed: 1, createdAsync: 2 });
  });
});

describe("modelFilePaths", () => {
  it("points at the four expected Parakeet files", () => {
    const paths = modelFilePaths("models/parakeet");
    expect(paths.encoder).toBe("models/parakeet/encoder.int8.onnx");
    expect(paths.decoder).toBe("models/parakeet/decoder.int8.onnx");
    expect(paths.joiner).toBe("models/parakeet/joiner.int8.onnx");
    expect(paths.tokens).toBe("models/parakeet/tokens.txt");
  });

  it("strips a trailing slash from the model dir", () => {
    const paths = modelFilePaths("/vault/models/parakeet/");
    expect(paths.encoder).toBe("/vault/models/parakeet/encoder.int8.onnx");
  });
});

describe("buildRecognizerConfig", () => {
  it("uses the offline transducer keys from sherpa-onnx-node", () => {
    const config = buildRecognizerConfig("models/parakeet");
    expect(config.featConfig).toEqual({ sampleRate: 16000, featureDim: 80 });
    expect(config.modelConfig.transducer).toEqual({
      encoder: "models/parakeet/encoder.int8.onnx",
      decoder: "models/parakeet/decoder.int8.onnx",
      joiner: "models/parakeet/joiner.int8.onnx",
    });
    expect(config.modelConfig.tokens).toBe("models/parakeet/tokens.txt");
    expect(config.modelConfig.numThreads).toBeGreaterThan(0);
    expect(config.modelConfig.provider).toBe("cpu");
  });

  it("references only the known model file names", () => {
    const config = buildRecognizerConfig("m");
    const referenced = [
      config.modelConfig.transducer.encoder,
      config.modelConfig.transducer.decoder,
      config.modelConfig.transducer.joiner,
      config.modelConfig.tokens,
    ];
    for (const p of referenced) {
      const base = p.split("/").pop() as string;
      expect(Object.values(MODEL_FILE_NAMES)).toContain(base);
    }
  });
});

describe("missingModelFiles", () => {
  it("reports which files are absent", () => {
    const present = new Set(["models/parakeet/encoder.int8.onnx"]);
    const missing = missingModelFiles("models/parakeet", (p) =>
      present.has(p),
    );
    expect(missing).toEqual([
      "models/parakeet/decoder.int8.onnx",
      "models/parakeet/joiner.int8.onnx",
      "models/parakeet/tokens.txt",
    ]);
  });

  it("returns an empty list when everything exists", () => {
    const missing = missingModelFiles("models/parakeet", () => true);
    expect(missing).toEqual([]);
  });
});

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
  ModelFilesMissingError,
  buildRecognizerConfig,
  loadSherpaOnnx,
  missingModelFiles,
  missingModelFilesMessage,
  modelFilePaths,
  releaseRecognizer,
  splitAtQuietPoints,
  transcribe,
  transcribeLongWithTimestamps,
  transcribeWithTimestamps,
  wordsFromTokens,
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
let nextResult = null;

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
    return nextResult ?? { text: "  hello world  " };
  }
}

module.exports = {
  __fake: true,
  OfflineRecognizer,
  getLastConfig: () => lastConfig,
  getLastWaveform: () => lastWaveform,
  counts: () => ({ constructed, createdAsync }),
  failNextCreate: () => { failNextCreate = true; },
  setNextResult: (result) => { nextResult = result; },
  reset: () => {
    lastConfig = undefined;
    lastWaveform = undefined;
    constructed = 0;
    createdAsync = 0;
    failNextCreate = false;
    nextResult = null;
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

  it("rejects with ModelFilesMissingError and drops the cache when a model file goes missing", async () => {
    await transcribe(pcm, modelDir, pluginDir);
    const tokens = path.join(modelDir, MODEL_FILE_NAMES.tokens);
    unlinkSync(tokens);
    try {
      const failure = transcribe(pcm, modelDir, pluginDir);
      await expect(failure).rejects.toBeInstanceOf(ModelFilesMissingError);
      await expect(failure).rejects.toMatchObject({
        missing: [`${modelDir}/tokens.txt`],
      });
      // The message carries the download hint, so callers can show it as is.
      await expect(failure).rejects.toThrow(
        /missing: .*tokens\.txt\. Run the 'Download Parakeet model' command first\./,
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

  it("transcribeWithTimestamps returns the words the tokens spell", async () => {
    loadSherpaOnnx(pluginDir).setNextResult({
      text: " Hello there. ",
      tokens: [" Hello", " there", "."],
      timestamps: [0.1, 0.5, 0.7],
      durations: [],
    });
    const result = await transcribeWithTimestamps(pcm, modelDir, pluginDir);
    expect(result.text).toBe("Hello there.");
    // `pcm` is one second long, so the last word is capped there.
    expect(result.words).toEqual([
      { text: "Hello", start: 0.1, end: 0.5 },
      { text: "there.", start: 0.5, end: 1 },
    ]);
  });

  it("transcribeWithTimestamps yields no words when the result carries no timestamps", async () => {
    const result = await transcribeWithTimestamps(pcm, modelDir, pluginDir);
    expect(result).toEqual({ text: "hello world", words: [] });
  });

  it("transcribeLongWithTimestamps decodes windows and shifts word times", async () => {
    loadSherpaOnnx(pluginDir).setNextResult({
      text: "one",
      tokens: [" one"],
      timestamps: [0.25],
      durations: [],
    });
    const progress: string[] = [];
    const result = await transcribeLongWithTimestamps(
      new Float32Array(16000 * 5),
      modelDir,
      pluginDir,
      16000,
      {
        maxSeconds: 2,
        searchSeconds: 0.5,
        onProgress: (done, total) => progress.push(`${done}/${total}`),
      },
    );
    // Silence everywhere, so each cut lands 50 ms into the search span:
    // windows start at 0, 1.55 s and 3.1 s.
    expect(result.text).toBe("one one one");
    expect(result.words.map((w) => w.text)).toEqual(["one", "one", "one"]);
    expect(result.words[0].start).toBeCloseTo(0.25, 5);
    expect(result.words[1].start).toBeCloseTo(1.8, 5);
    expect(result.words[2].start).toBeCloseTo(3.35, 5);
    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
  });
});

describe("wordsFromTokens", () => {
  it("starts a word at a piece with a leading space or ▁ and extends it otherwise", () => {
    const words = wordsFromTokens(
      [" Well", ",", " I", " don", "'", "t", "▁know"],
      [0.32, 0.64, 0.72, 0.8, 0.88, 0.96, 1.2],
      [],
      2,
    );
    expect(words.map((w) => w.text)).toEqual(["Well,", "I", "don't", "know"]);
    expect(words.map((w) => w.start)).toEqual([0.32, 0.72, 0.8, 1.2]);
  });

  it("ends a word where the next starts, capped at maxWordSeconds and the audio length", () => {
    const words = wordsFromTokens([" a", " b", " c"], [0, 0.5, 3], [], 3.2);
    expect(words.map((w) => w.end)).toEqual([0.5, 1.5, 3.2]);
  });

  it("uses durations when the recognizer reports them", () => {
    const words = wordsFromTokens(
      [" a", "b", " c"],
      [0, 0.2, 1],
      [0.1, 0.3, 0.4],
      5,
    );
    expect(words).toEqual([
      { text: "ab", start: 0, end: 0.5 },
      { text: "c", start: 1, end: 1.4 },
    ]);
  });

  it("returns no words when the arrays are absent or inconsistent", () => {
    expect(wordsFromTokens(undefined, undefined, undefined, 1)).toEqual([]);
    expect(wordsFromTokens([" a"], [], [], 1)).toEqual([]);
    expect(wordsFromTokens([], [], [], 1)).toEqual([]);
  });

  it("treats a space-only piece as a word boundary and starts without a space", () => {
    const words = wordsFromTokens(["Hi", " ", "there"], [0, 0.1, 0.2], [], 1);
    expect(words).toEqual([
      { text: "Hi", start: 0, end: 0.2 },
      { text: "there", start: 0.2, end: 1 },
    ]);
  });

  it("never yields an end before the start", () => {
    const words = wordsFromTokens([" a", " b"], [1, 0.5], [], 2);
    expect(words[0]).toEqual({ text: "a", start: 1, end: 1 });
  });
});

describe("splitAtQuietPoints", () => {
  it("returns a single window for audio within the limit", () => {
    expect(splitAtQuietPoints(new Float32Array(100), 100, 2, 1)).toEqual([
      0, 100,
    ]);
  });

  it("cuts at the quietest point before the window limit", () => {
    const rate = 1000;
    const pcm = new Float32Array(rate * 5).fill(0.5);
    pcm.fill(0, 1600, 1800); // silence from 1.6 s to 1.8 s
    const bounds = splitAtQuietPoints(pcm, rate, 2, 1);
    expect(bounds[0]).toBe(0);
    expect(bounds[1]).toBeGreaterThanOrEqual(1600);
    expect(bounds[1]).toBeLessThanOrEqual(1800);
    expect(bounds[bounds.length - 1]).toBe(pcm.length);
  });

  it("never produces a window longer than the limit", () => {
    const rate = 1000;
    const pcm = new Float32Array(rate * 7).fill(0.3);
    const bounds = splitAtQuietPoints(pcm, rate, 2, 0.5);
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i] - bounds[i - 1]).toBeLessThanOrEqual(2000);
      expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    }
    expect(bounds[bounds.length - 1]).toBe(7000);
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

describe("missingModelFilesMessage", () => {
  it("lists the files and points at the download command", () => {
    expect(missingModelFilesMessage(["m/a.onnx", "m/tokens.txt"])).toBe(
      "Parakeet model files are missing: m/a.onnx, m/tokens.txt. " +
        "Run the 'Download Parakeet model' command first.",
    );
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

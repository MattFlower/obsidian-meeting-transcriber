import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MODEL_FILE_NAMES,
  buildRecognizerConfig,
  loadSherpaOnnx,
  missingModelFiles,
  modelFilePaths,
  transcribe,
} from "../src/transcriber";

describe("plugin-directory module resolution", () => {
  let pluginDir: string;

  beforeAll(() => {
    pluginDir = mkdtempSync(path.join(tmpdir(), "plugin-dir-"));
    writeFileSync(path.join(pluginDir, "package.json"), "{}");

    const moduleDir = path.join(
      pluginDir,
      "node_modules",
      "sherpa-onnx-node",
    );
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      path.join(moduleDir, "package.json"),
      JSON.stringify({ main: "index.js" }),
    );
    writeFileSync(
      path.join(moduleDir, "index.js"),
      `let lastConfig;
class OfflineRecognizer {
  constructor(config) { lastConfig = config; }
  createStream() {
    return { acceptWaveform() {} };
  }
  decode() {}
  getResult() { return { text: "  hello world  " }; }
  dispose() {}
}
module.exports = {
  __fake: true,
  OfflineRecognizer,
  getLastConfig: () => lastConfig,
};
`,
    );
  });

  afterAll(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  it("loads sherpa-onnx-node from the installed plugin directory", () => {
    expect(loadSherpaOnnx(pluginDir).__fake).toBe(true);
  });

  it("uses the anchored module through the recognizer path", async () => {
    const text = await transcribe(
      new Float32Array(16000),
      "models/parakeet",
      pluginDir,
    );

    expect(text).toBe("hello world");
    const sherpa = loadSherpaOnnx(pluginDir);
    expect(sherpa.getLastConfig().modelConfig.transducer.encoder).toBe(
      "models/parakeet/encoder.int8.onnx",
    );
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

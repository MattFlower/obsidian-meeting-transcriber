import { describe, expect, it } from "vitest";
import {
  MODEL_FILE_NAMES,
  buildRecognizerConfig,
  missingModelFiles,
  modelFilePaths,
} from "../src/transcriber";

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

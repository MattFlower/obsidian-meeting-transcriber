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
  DEFAULT_DIARIZATION_OPTIONS,
  DIARIZATION_MODEL_FILE_NAMES,
  DIARIZATION_SAMPLE_RATE,
  DiarizationModelFilesMissingError,
  type DiarizeProgress,
  buildDiarizationConfig,
  clusteringConfig,
  diarizationModelFilePaths,
  diarize,
  getDiarizer,
  loadSherpaOnnxAddon,
  missingDiarizationModelFiles,
  missingDiarizationModelFilesMessage,
  releaseDiarizer,
} from "../src/diarize";
import { loadSherpaOnnx } from "../src/transcriber";

// ---------------------------------------------------------------------------
// Fake sherpa-onnx-node package
// ---------------------------------------------------------------------------

/**
 * Fake `addon.js`. It owns all the recording state (both the wrapper class
 * and the async entry point mutate it), and because `src/diarize.ts` and the
 * fake `index.js` resolve it to the same absolute path, Node's require cache
 * hands every party the same instance. Tests reach the state through the
 * exported controls, exactly how `tests/transcriber.test.ts` drives its fake.
 *
 * The addon's default segments are grouped by speaker, not sorted by time,
 * to match the real binding's output.
 */
function fakeAddonSource(withAsync: boolean): string {
  const asyncExport = withAsync
    ? "offlineSpeakerDiarizationProcessAsync,"
    : "";
  return `
const state = {};

function reset() {
  state.constructed = 0;
  state.lastConfig = undefined;
  state.lastHandle = undefined;
  state.sampleRate = 16000;
  state.failNextConstruct = false;
  state.rejectNextAsync = false;
  state.segments = [
    { start: 0, end: 2, speaker: 0 },
    { start: 4, end: 6, speaker: 0 },
    { start: 2, end: 4, speaker: 1 },
  ];
  state.calls = [];
  state.setConfigCalls = [];
  state.processCalls = [];
  state.asyncCalls = [];
  state.holds = [];
}
reset();

// Mirrors the native binding: exactly three arguments, the third a function,
// or a TypeError is thrown synchronously.
function offlineSpeakerDiarizationProcessAsync(handle, samples, progress) {
  if (arguments.length !== 3 || typeof progress !== "function") {
    throw new TypeError(
      "offlineSpeakerDiarizationProcessAsync expects (handle, samples, progressCallback)",
    );
  }
  state.calls.push("async:start");
  state.asyncCalls.push({ handle, samples, progressType: typeof progress });
  return (async () => {
    const hold = state.holds.shift();
    if (hold) await hold;
    progress(1, 2);
    progress(2, 2);
    if (state.rejectNextAsync) {
      state.rejectNextAsync = false;
      state.calls.push("async:reject");
      throw new Error("diarization failed");
    }
    state.calls.push("async:end");
    return state.segments;
  })();
}

module.exports = {
  __fakeAddon: true,
  state,
  reset,
  ${asyncExport}
};
`;
}

const FAKE_INDEX_SOURCE = `
const addon = require("./addon.js");
const { state } = addon;

class OfflineSpeakerDiarization {
  constructor(config) {
    state.constructed += 1;
    state.calls.push("construct");
    if (state.failNextConstruct) {
      state.failNextConstruct = false;
      throw new Error("construct failed");
    }
    this.config = config;
    this.handle = { id: state.constructed };
    this.sampleRate = state.sampleRate;
    state.lastConfig = config;
    state.lastHandle = this.handle;
  }
  process(samples) {
    state.calls.push("process");
    state.processCalls.push(samples);
    return state.segments;
  }
  setConfig(config) {
    state.calls.push("setConfig");
    state.setConfigCalls.push(config);
    this.config.clustering = config.clustering;
  }
}

module.exports = {
  __fake: true,
  OfflineSpeakerDiarization,
  state,
  reset: addon.reset,
};
`;

interface FakePlugin {
  pluginDir: string;
  modelDir: string;
  otherModelDir: string;
}

function writeModelFiles(modelDir: string): void {
  mkdirSync(modelDir, { recursive: true });
  for (const name of Object.values(DIARIZATION_MODEL_FILE_NAMES)) {
    writeFileSync(path.join(modelDir, name), "");
  }
}

/** Install the fake package under a fresh temp plugin dir with two model dirs. */
function writeFakePlugin(withAsync: boolean): FakePlugin {
  const pluginDir = mkdtempSync(path.join(tmpdir(), "diarize-plugin-"));
  writeFileSync(path.join(pluginDir, "package.json"), "{}");

  const moduleDir = path.join(pluginDir, "node_modules", "sherpa-onnx-node");
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(
    path.join(moduleDir, "package.json"),
    JSON.stringify({ main: "index.js" }),
  );
  writeFileSync(path.join(moduleDir, "index.js"), FAKE_INDEX_SOURCE);
  writeFileSync(path.join(moduleDir, "addon.js"), fakeAddonSource(withAsync));

  const modelDir = path.join(pluginDir, "models", "diarization");
  const otherModelDir = path.join(pluginDir, "models", "other");
  writeModelFiles(modelDir);
  writeModelFiles(otherModelDir);
  return { pluginDir, modelDir, otherModelDir };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every queued microtask run (a macrotask turn drains them all). */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("diarizationModelFilePaths", () => {
  it("points at the segmentation and embedding models", () => {
    const paths = diarizationModelFilePaths("models/diarization");
    expect(paths).toEqual({
      segmentation: "models/diarization/pyannote-segmentation-3-0.int8.onnx",
      embedding: "models/diarization/nemo_en_titanet_small.onnx",
    });
  });

  it("strips trailing slashes from the model dir", () => {
    const paths = diarizationModelFilePaths("/vault/models/diarization//");
    expect(paths.segmentation).toBe(
      "/vault/models/diarization/pyannote-segmentation-3-0.int8.onnx",
    );
  });
});

describe("missingDiarizationModelFiles", () => {
  it("reports which files are absent", () => {
    const present = new Set([
      "models/diarization/pyannote-segmentation-3-0.int8.onnx",
    ]);
    const missing = missingDiarizationModelFiles("models/diarization", (p) =>
      present.has(p),
    );
    expect(missing).toEqual(["models/diarization/nemo_en_titanet_small.onnx"]);
  });

  it("returns an empty list when everything exists", () => {
    expect(missingDiarizationModelFiles("m", () => true)).toEqual([]);
  });
});

describe("missingDiarizationModelFilesMessage", () => {
  it("lists the files and points at the download command", () => {
    expect(missingDiarizationModelFilesMessage(["m/a.onnx", "m/b.onnx"])).toBe(
      "Diarization model files are missing: m/a.onnx, m/b.onnx. " +
        "Run the 'Download diarization models' command first.",
    );
  });

  it("is the message DiarizationModelFilesMissingError carries", () => {
    const error = new DiarizationModelFilesMissingError(["m/a.onnx"]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DiarizationModelFilesMissingError");
    expect(error.missing).toEqual(["m/a.onnx"]);
    expect(error.message).toBe(missingDiarizationModelFilesMessage(["m/a.onnx"]));
  });
});

describe("buildDiarizationConfig", () => {
  it("asks the clusterer to pick the speaker count when numSpeakers is 0", () => {
    const config = buildDiarizationConfig("models/diarization", {
      numSpeakers: 0,
      threshold: 0.7,
    });
    expect(config.clustering).toEqual({ numClusters: -1, threshold: 0.7 });
    expect(config.segmentation).toEqual({
      pyannote: {
        model: "models/diarization/pyannote-segmentation-3-0.int8.onnx",
        windowShiftRatio: 0.1,
      },
      numThreads: 2,
      provider: "cpu",
      debug: false,
    });
    expect(config.embedding).toEqual({
      model: "models/diarization/nemo_en_titanet_small.onnx",
      numThreads: 2,
      provider: "cpu",
      debug: false,
    });
    expect(config.minDurationOn).toBe(0.3);
    expect(config.minDurationOff).toBe(0.5);
  });

  it("passes an exact cluster count when numSpeakers is positive", () => {
    const config = buildDiarizationConfig("m", {
      numSpeakers: 3,
      threshold: 0.5,
      numThreads: 4,
    });
    expect(config.clustering).toEqual({ numClusters: 3, threshold: 0.5 });
    expect(config.segmentation.numThreads).toBe(4);
    expect(config.embedding.numThreads).toBe(4);
  });

  it("references only the known model file names", () => {
    const config = buildDiarizationConfig("m", DEFAULT_DIARIZATION_OPTIONS);
    for (const p of [config.segmentation.pyannote.model, config.embedding.model]) {
      const base = p.split("/").pop() as string;
      expect(Object.values(DIARIZATION_MODEL_FILE_NAMES)).toContain(base);
    }
  });
});

describe("clusteringConfig", () => {
  it("matches the clustering block buildDiarizationConfig emits", () => {
    for (const opts of [
      DEFAULT_DIARIZATION_OPTIONS,
      { numSpeakers: 2, threshold: 0.3 },
      { numSpeakers: 0, threshold: 0.9 },
    ]) {
      expect(clusteringConfig(opts)).toEqual(
        buildDiarizationConfig("m", opts).clustering,
      );
    }
  });

  it("defaults to automatic detection at threshold 0.5", () => {
    expect(DEFAULT_DIARIZATION_OPTIONS).toEqual({ numSpeakers: 0, threshold: 0.5 });
    expect(clusteringConfig(DEFAULT_DIARIZATION_OPTIONS)).toEqual({
      numClusters: -1,
      threshold: 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
// diarize with the fake addon that exports the async entry point
// ---------------------------------------------------------------------------

describe("diarize with the plugin-directory diarizer", () => {
  let pluginDir: string;
  let modelDir: string;
  let otherModelDir: string;
  const pcm = new Float32Array(16000);
  const fake = () => loadSherpaOnnx(pluginDir);
  const state = () => fake().state;

  beforeAll(() => {
    ({ pluginDir, modelDir, otherModelDir } = writeFakePlugin(true));
  });

  afterAll(() => {
    releaseDiarizer();
    rmSync(pluginDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    releaseDiarizer();
    fake().reset();
  });

  it("loads the wrapper and the addon from the installed plugin directory", () => {
    expect(fake().__fake).toBe(true);
    const addon = loadSherpaOnnxAddon(pluginDir);
    expect(addon.__fakeAddon).toBe(true);
    // Same module instance as the one the wrapper class uses, so a wrapper's
    // handle is valid for the addon's functions.
    expect(addon.state).toBe(state());
    expect(loadSherpaOnnxAddon(`${pluginDir}/`)).toBe(addon);
  });

  it("constructs the diarizer once with the default config and reuses it", async () => {
    const first = await diarize(pcm, modelDir, pluginDir);
    const second = await diarize(pcm, modelDir, pluginDir);

    expect(first).toEqual(second);
    expect(state().constructed).toBe(1);
    expect(state().lastConfig).toEqual(
      buildDiarizationConfig(modelDir, DEFAULT_DIARIZATION_OPTIONS),
    );
    expect(await getDiarizer(modelDir, pluginDir)).toBe(
      await getDiarizer(modelDir, pluginDir),
    );
  });

  it("shares one in-flight construction between concurrent callers", async () => {
    await Promise.all([
      diarize(pcm, modelDir, pluginDir),
      diarize(pcm, modelDir, pluginDir),
      getDiarizer(modelDir, pluginDir),
    ]);
    expect(state().constructed).toBe(1);
  });

  it("builds a new diarizer when the model directory changes", async () => {
    await diarize(pcm, modelDir, pluginDir);
    await diarize(pcm, otherModelDir, pluginDir);
    expect(state().constructed).toBe(2);
    expect(state().lastConfig.embedding.model).toBe(
      `${otherModelDir}/${DIARIZATION_MODEL_FILE_NAMES.embedding}`,
    );
    // Only one diarizer is held: switching back rebuilds again.
    await diarize(pcm, modelDir, pluginDir);
    expect(state().constructed).toBe(3);
  });

  it("treats a trailing slash on either directory as the same diarizer", async () => {
    await diarize(pcm, modelDir, pluginDir);
    await diarize(pcm, `${modelDir}/`, `${pluginDir}/`);
    expect(state().constructed).toBe(1);
  });

  it("releaseDiarizer() drops the cache so the next call rebuilds", async () => {
    await diarize(pcm, modelDir, pluginDir);
    releaseDiarizer();
    await diarize(pcm, modelDir, pluginDir);
    expect(state().constructed).toBe(2);
  });

  it("calls setConfig only when the clustering options change", async () => {
    // The defaults already match the constructor config: no setConfig.
    await diarize(pcm, modelDir, pluginDir);
    await diarize(pcm, modelDir, pluginDir, { numSpeakers: 0, threshold: 0.5 });
    expect(state().setConfigCalls).toEqual([]);

    await diarize(pcm, modelDir, pluginDir, { numSpeakers: 2, threshold: 0.5 });
    expect(state().setConfigCalls).toEqual([
      { clustering: { numClusters: 2, threshold: 0.5 } },
    ]);

    // Same options again: the handle already holds them.
    await diarize(pcm, modelDir, pluginDir, { numSpeakers: 2, threshold: 0.5 });
    expect(state().setConfigCalls).toHaveLength(1);

    // A threshold change under automatic detection is a change too.
    await diarize(pcm, modelDir, pluginDir, { numSpeakers: 0, threshold: 0.8 });
    expect(state().setConfigCalls[1]).toEqual({
      clustering: { numClusters: -1, threshold: 0.8 },
    });

    // Back to the defaults must be applied again: the handle no longer has them.
    await diarize(pcm, modelDir, pluginDir);
    expect(state().setConfigCalls[2]).toEqual({
      clustering: { numClusters: -1, threshold: 0.5 },
    });
    expect(state().setConfigCalls).toHaveLength(3);
    // numThreads only matters at construction, so changing it is not a
    // clustering change.
    await diarize(pcm, modelDir, pluginDir, { ...DEFAULT_DIARIZATION_OPTIONS, numThreads: 8 });
    expect(state().setConfigCalls).toHaveLength(3);
    expect(state().constructed).toBe(1);
  });

  it("rejects with DiarizationModelFilesMissingError and drops the cache when a model file goes missing", async () => {
    await diarize(pcm, modelDir, pluginDir);
    const embedding = path.join(modelDir, DIARIZATION_MODEL_FILE_NAMES.embedding);
    unlinkSync(embedding);
    try {
      const failure = diarize(pcm, modelDir, pluginDir);
      await expect(failure).rejects.toBeInstanceOf(DiarizationModelFilesMissingError);
      await expect(failure).rejects.toMatchObject({
        missing: [`${modelDir}/${DIARIZATION_MODEL_FILE_NAMES.embedding}`],
      });
      await expect(failure).rejects.toThrow(
        /missing: .*nemo_en_titanet_small\.onnx\. Run the 'Download diarization models' command first\./,
      );
      await expect(getDiarizer(modelDir, pluginDir)).rejects.toBeInstanceOf(
        DiarizationModelFilesMissingError,
      );
    } finally {
      writeFileSync(embedding, "");
    }
    await diarize(pcm, modelDir, pluginDir);
    expect(state().constructed).toBe(2);
  });

  it("does not cache a failed construction", async () => {
    state().failNextConstruct = true;
    await expect(diarize(pcm, modelDir, pluginDir)).rejects.toThrow(
      "construct failed",
    );
    await expect(diarize(pcm, modelDir, pluginDir)).resolves.toHaveLength(3);
    expect(state().constructed).toBe(2);
  });

  it("serialises concurrent calls so setConfig and process never interleave", async () => {
    const addon = loadSherpaOnnxAddon(pluginDir);
    const gate = deferred();
    addon.state.holds.push(gate.promise);

    const first = diarize(pcm, modelDir, pluginDir, { numSpeakers: 2, threshold: 0.5 });
    const second = diarize(pcm, modelDir, pluginDir, { numSpeakers: 3, threshold: 0.5 });
    await flush();
    // The first run is parked inside the addon; the second has not started.
    expect(addon.state.calls).toEqual(["construct", "setConfig", "async:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(addon.state.calls).toEqual([
      "construct",
      "setConfig",
      "async:start",
      "async:end",
      "setConfig",
      "async:start",
      "async:end",
    ]);
    expect(addon.state.setConfigCalls.map((c: any) => c.clustering.numClusters)).toEqual([2, 3]);
  });

  it("uses the async addon entry point with the wrapper's handle and never the blocking process", async () => {
    await diarize(pcm, modelDir, pluginDir);
    const addon = loadSherpaOnnxAddon(pluginDir);
    expect(addon.state.processCalls).toEqual([]);
    expect(addon.state.asyncCalls).toHaveLength(1);
    expect(addon.state.asyncCalls[0].handle).toBe(addon.state.lastHandle);
    expect(addon.state.asyncCalls[0].samples).toBe(pcm);
    // A progress function is always supplied: the native side needs 3 args.
    expect(addon.state.asyncCalls[0].progressType).toBe("function");
  });

  it("forwards progress from the addon", async () => {
    const seen: DiarizeProgress[] = [];
    await diarize(pcm, modelDir, pluginDir, undefined, (p) => seen.push(p));
    expect(seen).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
  });

  it("returns fresh segments sorted by start, then end, then speaker", async () => {
    state().segments = [
      { start: 5, end: 7, speaker: 1 },
      { start: 0, end: 2, speaker: 1 },
      { start: 0, end: 1, speaker: 0 },
      { start: 0, end: 2, speaker: 0 },
      { start: 2, end: 5, speaker: 0 },
    ];
    const segments = await diarize(pcm, modelDir, pluginDir);
    expect(segments).toEqual([
      { start: 0, end: 1, speaker: 0 },
      { start: 0, end: 2, speaker: 0 },
      { start: 0, end: 2, speaker: 1 },
      { start: 2, end: 5, speaker: 0 },
      { start: 5, end: 7, speaker: 1 },
    ]);
    // Copies, not the addon's own objects or array.
    expect(segments).not.toBe(state().segments);
    for (const segment of segments) {
      expect(state().segments).not.toContain(segment);
    }
  });

  it("rejects when the models expect a different sample rate", async () => {
    state().sampleRate = 8000;
    await expect(diarize(pcm, modelDir, pluginDir)).rejects.toThrow(/8000/);
    expect(DIARIZATION_SAMPLE_RATE).toBe(16000);
  });

  it("recovers after a rejected diarization without rebuilding", async () => {
    state().rejectNextAsync = true;
    await expect(diarize(pcm, modelDir, pluginDir)).rejects.toThrow(
      "diarization failed",
    );
    await expect(diarize(pcm, modelDir, pluginDir)).resolves.toHaveLength(3);
    expect(state().constructed).toBe(1);
    expect(state().calls).toEqual([
      "construct",
      "async:start",
      "async:reject",
      "async:start",
      "async:end",
    ]);
  });
});

// ---------------------------------------------------------------------------
// diarize with an addon that lacks the async entry point
// ---------------------------------------------------------------------------

describe("diarize with an addon that has no async entry point", () => {
  let pluginDir: string;
  let modelDir: string;
  const pcm = new Float32Array(16000);
  const fake = () => loadSherpaOnnx(pluginDir);

  beforeAll(() => {
    ({ pluginDir, modelDir } = writeFakePlugin(false));
  });

  afterAll(() => {
    releaseDiarizer();
    rmSync(pluginDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    releaseDiarizer();
    fake().reset();
  });

  it("falls back to the blocking process and still sorts the result", async () => {
    const addon = loadSherpaOnnxAddon(pluginDir);
    expect(addon.offlineSpeakerDiarizationProcessAsync).toBeUndefined();

    const seen: DiarizeProgress[] = [];
    const segments = await diarize(pcm, modelDir, pluginDir, undefined, (p) =>
      seen.push(p),
    );

    expect(addon.state.processCalls).toEqual([pcm]);
    expect(addon.state.asyncCalls).toEqual([]);
    expect(segments).toEqual([
      { start: 0, end: 2, speaker: 0 },
      { start: 2, end: 4, speaker: 1 },
      { start: 4, end: 6, speaker: 0 },
    ]);
    // The blocking path has no progress to report.
    expect(seen).toEqual([]);
  });
});

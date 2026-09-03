import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LiveSessionRegistry,
  type LiveAudioSink,
  type LiveSpeakerSource,
} from "../src/live";
import type { TranscriberSettings } from "../src/settings";
import {
  feed,
  feedLanes,
  LOOPBACK_DEVICE_ID,
  makeWorld,
  type FakeWorld,
} from "./helpers/fake-audio";
import {
  FakeEl,
  Notice,
  Option,
  TFile,
  WorkspaceLeaf,
} from "./helpers/obsidian-stub";

// Chunk transcription goes through the native sherpa-onnx addon; stub it so
// the test stays headless and can hold a chunk "in flight".
vi.mock("../src/transcriber", () => {
  const transcribe = vi.fn();
  return {
    transcribe,
    // By default the text of `transcribe` without timestamps, which the
    // panel spreads over the chunk itself, so string-based cases still work.
    transcribeWithTimestamps: vi.fn(
      async (pcm: Float32Array, modelDir: string, pluginDir: string) => ({
        text: (await transcribe(pcm, modelDir, pluginDir)) ?? "",
        words: [],
      }),
    ),
    missingModelFilesMessage: vi.fn((missing: string[]) => missing.join(", ")),
  };
});

import { transcribe, transcribeWithTimestamps } from "../src/transcriber";
import { LiveRecordingPanel, type LiveRecordingHost } from "../src/live-panel";

const transcribeMock = vi.mocked(transcribe);
const transcribeWithTimestampsMock = vi.mocked(transcribeWithTimestamps);

/** Stands in for the temporary WAV a session records into. */
class FakeSink implements LiveAudioSink {
  path = "/tmp/obsidian-meeting-transcriber/live.wav";
  failed: Error | null = null;
  frames: Float32Array[][] = [];
  closed = false;
  aborted = false;

  write(lanes: Float32Array[]): void {
    this.frames.push(lanes);
  }

  async close(): Promise<unknown> {
    this.closed = true;
    return { dataBytes: 0, seconds: 0 };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}
const REFUSAL =
  "A live recording is already in progress. Stop it before starting another.";

/** Let pending promise chains (session start/stop, the chunk pump) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Harness {
  panel: LiveRecordingPanel;
  setStatus: ReturnType<typeof vi.fn>;
  world: FakeWorld;
  vault: { read: ReturnType<typeof vi.fn>; process: ReturnType<typeof vi.fn> };
  /** Every note body written through vault.process, in order. */
  written: string[];
  /** The panel's two buttons: start/stop and pause/resume. */
  buttons(): { startStop: FakeEl; pause: FakeEl };
  /** The owner tag the panel used for its status-bar line. */
  owner(): string;
  /** The host's normalizeNoteTranscript, called by the stop flow. */
  normalize: ReturnType<typeof vi.fn>;
  /** The host's assignSpeakersToLiveNote, called by the stop flow. */
  assignSpeakers: ReturnType<typeof vi.fn>;
  openSink: ReturnType<typeof vi.fn>;
  /** The sink openSink hands out (shared by every session of the harness). */
  sink: FakeSink;
  /** The panel's three selects: audio source, microphone, system device. */
  selects(): { source: FakeEl; mic: FakeEl; device: FakeEl };
  registry: LiveSessionRegistry;
}

interface HarnessOptions {
  registry?: LiveSessionRegistry;
  createNote?: LiveRecordingHost["createNote"];
  settings?: Partial<TranscriberSettings>;
  normalize?: LiveRecordingHost["normalizeNoteTranscript"];
  assignSpeakers?: LiveRecordingHost["assignSpeakersToLiveNote"];
  /** openSink resolves null (file could not be created). */
  noSink?: boolean;
  missingDiarization?: string[];
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const registry = opts.registry ?? new LiveSessionRegistry();
  const world = makeWorld();
  let current = "---\ntitle: live\n---\n\n## Transcript\n";
  const written: string[] = [];
  const vault = {
    read: vi.fn(async () => current),
    // Obsidian's atomic read-modify-write: each callback sees the note as
    // the previous write left it. The panel must use this rather than
    // read() followed by modify(); the fake has no modify() at all.
    process: vi.fn(async (_file: TFile, fn: (data: string) => string) => {
      current = fn(current);
      written.push(current);
      return current;
    }),
  };
  const setStatus = vi.fn();
  const normalize = vi.fn(opts.normalize ?? (async (_note: TFile) => {}));
  const assignSpeakers = vi.fn(
    opts.assignSpeakers ??
      (async (_note: TFile, _source: LiveSpeakerSource) => {}),
  );
  const sink = new FakeSink();
  const openSink = vi.fn(async (_note: TFile, _channels: number) =>
    opts.noSink ? null : sink,
  );
  const host: LiveRecordingHost = {
    settings: {
      liveChunkSeconds: 15,
      liveAudioSource: "microphone",
      ...opts.settings,
    } as TranscriberSettings,
    resolveModelDir: () => "/vault/models",
    resolvePluginDir: () => "/vault/.obsidian/plugins/meeting-transcriber",
    findMissingModelFiles: () => [],
    findMissingDiarizationModelFiles: () => opts.missingDiarization ?? [],
    openLiveAudioSink: openSink,
    assignSpeakersToLiveNote: assignSpeakers,
    createNote:
      opts.createNote ??
      (async () => Object.assign(new TFile(), { path: "Meetings/live.md" })),
    setStatus,
    isLiveSessionActive: () => registry.isRecording(),
    claimLiveSession: (panel) => registry.tryClaim(panel),
    releaseLiveSession: (panel) => registry.release(panel),
    isUnloading: () => false,
    normalizeNoteTranscript: normalize,
  };
  const leaf = new WorkspaceLeaf({ vault });
  const panel = new LiveRecordingPanel(
    leaf as unknown as ConstructorParameters<typeof LiveRecordingPanel>[0],
    host,
    world.deps,
  );
  const content = (panel as unknown as { contentEl: FakeEl }).contentEl;
  return {
    panel,
    setStatus,
    world,
    vault,
    written,
    buttons: () => {
      const [startStop, pause] = content.findAll((el) => el.tag === "button");
      return { startStop, pause };
    },
    owner: () => setStatus.mock.calls[0]?.[0] as string,
    normalize,
    assignSpeakers,
    openSink,
    sink,
    selects: () => {
      const [source, mic, device] = content.findAll((el) => el.tag === "select");
      return { source, mic, device };
    },
    registry,
  };
}

async function openAndStart(h: Harness): Promise<void> {
  await h.panel.onOpen();
  await settle();
  h.buttons().startStop.click();
  await settle();
}

describe("LiveRecordingPanel status bar", () => {
  beforeEach(() => {
    // The panel uses the browser globals `Option` and `window.setInterval`.
    Object.assign(globalThis, { Option, window: globalThis });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    transcribeMock.mockReset();
    transcribeMock.mockResolvedValue("");
    Notice.shown.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never touches the status bar while idle", async () => {
    const h = makeHarness();
    await h.panel.onOpen();
    await settle();
    vi.advanceTimersByTime(5000);
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("mirrors the session clock under its own owner tag and clears it once on stop", async () => {
    const h = makeHarness();
    await openAndStart(h);

    const owner = h.owner();
    expect(owner).toMatch(/^live-panel-\d+$/);
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "● Live recording 00:00");

    vi.advanceTimersByTime(1000);
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "● Live recording 00:01");

    h.buttons().pause.click();
    vi.advanceTimersByTime(1000);
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "⏸ Live paused 00:01");

    h.setStatus.mockClear();
    h.buttons().startStop.click(); // now "Stop recording"
    await settle();
    expect(h.setStatus.mock.calls).toEqual([[owner, ""]]);
    expect(h.written).toContainEqual(
      expect.stringContaining("_No speech detected._"),
    );

    // The refresh stops with the session: no more writes, ever.
    h.setStatus.mockClear();
    vi.advanceTimersByTime(5000);
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("toggles the pause button label Pause -> Resume -> Pause and flips the status bar at once", async () => {
    const h = makeHarness();
    await openAndStart(h);
    const owner = h.owner();
    const { startStop, pause } = h.buttons();
    expect(startStop.text).toBe("Stop recording");
    expect(pause.disabled).toBe(false);
    expect(pause.text).toBe("Pause");

    pause.click();
    expect(pause.text).toBe("Resume");
    // The status bar flips immediately, not on the next 1 s tick.
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "⏸ Live paused 00:00");

    pause.click();
    expect(pause.text).toBe("Pause");
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "● Live recording 00:00");
  });

  it("ignores a Pause click that lands during the stop flush", async () => {
    let finish!: (text: string) => void;
    transcribeMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const h = makeHarness();
    await openAndStart(h);
    // A partial chunk becomes the tail that stopSession() transcribes.
    feed(h.world.contexts[0], new Float32Array(16000 * 5));
    h.buttons().startStop.click(); // Stop recording
    await settle();
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const { startStop, pause } = h.buttons();
    expect(startStop.text).toBe("Stop recording");

    pause.click(); // still enabled while the tail is in flight
    expect(startStop.text).toBe("Stop recording");
    expect(pause.text).toBe("Pause");

    finish("");
    await settle();
    expect(startStop.text).toBe("Start recording");
    expect(pause.disabled).toBe(true);
  });

  it("shows the paused state even while a chunk is being transcribed", async () => {
    let finish!: (text: string) => void;
    transcribeMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const h = makeHarness();
    await openAndStart(h);
    const owner = h.owner();
    feed(h.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    expect(h.setStatus).toHaveBeenLastCalledWith(
      owner,
      "● Live: transcribing chunk… 00:00",
    );

    h.buttons().pause.click();
    expect(h.buttons().pause.text).toBe("Resume");
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "⏸ Live paused 00:00");

    finish("hello world");
    await settle();
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "⏸ Live paused 00:00");
  });

  it("reports an in-flight chunk transcription, then returns to the clock", async () => {
    let finish!: (text: string) => void;
    transcribeMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const h = makeHarness();
    await openAndStart(h);
    const owner = h.owner();

    // One full 15 s chunk at 16 kHz.
    feed(h.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    expect(h.setStatus).toHaveBeenLastCalledWith(
      owner,
      "● Live: transcribing chunk… 00:00",
    );

    finish("hello world");
    await settle();
    expect(h.written).toContainEqual(expect.stringContaining("hello world"));
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "● Live recording 00:00");
  });

  it("appends chunk text through vault.process, never read-then-modify", async () => {
    transcribeMock.mockResolvedValueOnce("hello world");
    const h = makeHarness();
    await openAndStart(h);
    feed(h.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    expect(h.vault.process).toHaveBeenCalledTimes(1);
    expect(h.written[0]).toContain("hello world");
    // A stale read() before the write is exactly what lost user edits.
    expect(h.vault.read).not.toHaveBeenCalled();
  });

  it("accumulates successive chunks in the same note", async () => {
    transcribeMock
      .mockResolvedValueOnce("one two")
      .mockResolvedValueOnce("three four");
    const h = makeHarness();
    await openAndStart(h);
    feed(h.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    feed(h.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    expect(h.vault.process).toHaveBeenCalledTimes(2);
    expect(h.written[1]).toContain("one two\n\nthree four");
  });

  it("refuses a second panel while another records, without touching the status bar", async () => {
    const registry = new LiveSessionRegistry();
    const a = makeHarness({ registry });
    const b = makeHarness({ registry });
    await openAndStart(a);
    await b.panel.onOpen();
    await settle();

    b.buttons().startStop.click();
    await settle();
    expect(Notice.shown).toContain(REFUSAL);
    expect(b.setStatus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(b.setStatus).not.toHaveBeenCalled();
    expect(a.setStatus).toHaveBeenLastCalledWith(a.owner(), "● Live recording 00:03");
  });

  it("does not resurrect a session stopped while its note was being created", async () => {
    let finishNote!: (note: TFile) => void;
    const h = makeHarness({
      createNote: () =>
        new Promise<TFile>((resolve) => {
          finishNote = resolve;
        }),
    });
    await h.panel.onOpen();
    await settle();
    h.buttons().startStop.click();
    await settle(); // capture is live; createNote is still pending

    await h.panel.onClose(); // ends the session while the note is in flight
    await settle();
    expect(h.world.micStream.tracks.every((t) => t.stopped)).toBe(true);

    h.setStatus.mockClear();
    finishNote(Object.assign(new TFile(), { path: "Meetings/late.md" }));
    await settle();

    // The late note is marked like any stopped session's, and no refresh or
    // status line is started for the dead session.
    expect(h.written).toContainEqual(
      expect.stringContaining("_No speech detected._"),
    );
    vi.advanceTimersByTime(5000);
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("closing the panel mid-session ends the session and the status bar refresh", async () => {
    const h = makeHarness();
    await openAndStart(h);
    const owner = h.owner();

    h.setStatus.mockClear();
    await h.panel.onClose();
    await settle();
    expect(h.world.micStream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.setStatus.mock.calls).toEqual([[owner, ""]]);

    h.setStatus.mockClear();
    vi.advanceTimersByTime(5000);
    expect(h.setStatus).not.toHaveBeenCalled();
  });
});

describe("LiveRecordingPanel normalization on stop", () => {
  const normalizerOn = { normalizerEnabled: true, normalizeLiveOnStop: true };

  beforeEach(() => {
    Object.assign(globalThis, { Option, window: globalThis });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    transcribeMock.mockReset();
    transcribeMock.mockResolvedValue("");
    Notice.shown.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function recordOneChunkAndStop(h: Harness): Promise<void> {
    await openAndStart(h);
    feed(h.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    h.buttons().startStop.click(); // Stop recording
    await settle();
  }

  it("hands the note to the host only after the session is torn down", async () => {
    transcribeMock.mockResolvedValueOnce("hello world");
    let atCall: { recording: boolean; button: string; stopped: boolean } | null =
      null;
    const h = makeHarness({
      settings: normalizerOn,
      normalize: async () => {
        atCall = {
          recording: h.registry.isRecording(),
          button: h.buttons().startStop.text,
          stopped: Notice.shown.includes("Live recording stopped."),
        };
      },
    });
    await recordOneChunkAndStop(h);

    expect(h.normalize).toHaveBeenCalledTimes(1);
    expect(h.normalize.mock.calls[0][0]).toMatchObject({ path: "Meetings/live.md" });
    expect(atCall).toEqual({
      recording: false,
      button: "Start recording",
      stopped: true,
    });
    // The raw chunk was written before normalization, never marked as silence.
    expect(h.written).toContainEqual(expect.stringContaining("hello world"));
    expect(h.written).not.toContainEqual(
      expect.stringContaining("_No speech detected._"),
    );
  });

  it("skips normalization when the session produced no speech", async () => {
    const h = makeHarness({ settings: normalizerOn });
    await recordOneChunkAndStop(h);
    expect(h.normalize).not.toHaveBeenCalled();
    expect(h.written).toContainEqual(
      expect.stringContaining("_No speech detected._"),
    );
  });

  it("skips normalization when the live toggle or the master switch is off", async () => {
    transcribeMock.mockResolvedValue("hello world");
    const toggleOff = makeHarness({
      settings: { normalizerEnabled: true, normalizeLiveOnStop: false },
    });
    await recordOneChunkAndStop(toggleOff);
    expect(toggleOff.normalize).not.toHaveBeenCalled();

    const masterOff = makeHarness({
      settings: { normalizerEnabled: false, normalizeLiveOnStop: true },
    });
    await recordOneChunkAndStop(masterOff);
    expect(masterOff.normalize).not.toHaveBeenCalled();
  });

  it("does not hold the session slot while a slow normalization runs", async () => {
    transcribeMock.mockResolvedValueOnce("hello world");
    const registry = new LiveSessionRegistry();
    const a = makeHarness({
      registry,
      settings: normalizerOn,
      normalize: () => new Promise<void>(() => undefined), // never settles
    });
    await recordOneChunkAndStop(a);
    expect(a.normalize).toHaveBeenCalledTimes(1);
    expect(registry.isRecording()).toBe(false);
    expect(a.buttons().startStop.text).toBe("Start recording");

    // Another panel can record while the first note is still normalizing.
    const b = makeHarness({ registry });
    await openAndStart(b);
    expect(Notice.shown).not.toContain(REFUSAL);
    expect(registry.isRecording()).toBe(true);
  });
});

describe("LiveRecordingPanel speaker pass on stop", () => {
  const speakersOn = { diarizationEnabled: true, diarizeLiveOnStop: true };
  const FRAME = 4096;

  beforeEach(() => {
    Object.assign(globalThis, { Option, window: globalThis });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    transcribeMock.mockReset();
    transcribeMock.mockResolvedValue("");
    transcribeWithTimestampsMock.mockClear();
    Notice.shown.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function recordOneChunkAndStop(h: Harness): Promise<void> {
    await openAndStart(h);
    feed(h.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    h.buttons().startStop.click(); // Stop recording
    await settle();
  }

  it("records audio only when the pass is enabled and its models are present", async () => {
    const off = makeHarness();
    await recordOneChunkAndStop(off);
    expect(off.openSink).not.toHaveBeenCalled();

    const on = makeHarness({ settings: speakersOn });
    await recordOneChunkAndStop(on);
    expect(on.openSink).toHaveBeenCalledTimes(1);
    expect(on.openSink.mock.calls[0][0]).toMatchObject({ path: "Meetings/live.md" });
    expect(on.openSink.mock.calls[0][1]).toBe(1);

    const missing = makeHarness({
      settings: speakersOn,
      missingDiarization: ["/vault/models/diarization/x.onnx"],
    });
    await recordOneChunkAndStop(missing);
    expect(missing.openSink).not.toHaveBeenCalled();
    expect(Notice.shown.some((n) => /without speaker labels/.test(n))).toBe(true);
  });

  it("writes every frame to the audio file, including those captured before it opened", async () => {
    let finishNote!: (note: TFile) => void;
    const h = makeHarness({
      settings: speakersOn,
      createNote: () =>
        new Promise<TFile>((resolve) => {
          finishNote = resolve;
        }),
    });
    await h.panel.onOpen();
    await settle();
    h.buttons().startStop.click();
    await settle(); // capture is live; the note (and so the file) is pending
    feed(h.world.contexts[0], new Float32Array(FRAME).fill(0.5));
    expect(h.sink.frames).toHaveLength(0);

    finishNote(Object.assign(new TFile(), { path: "Meetings/live.md" }));
    await settle();
    expect(h.sink.frames).toHaveLength(1);
    feed(h.world.contexts[0], new Float32Array(FRAME));
    expect(h.sink.frames).toHaveLength(2);
    expect(h.sink.frames[0][0][0]).toBe(0.5);
    expect(h.sink.frames.map((lanes) => lanes.length)).toEqual([1, 1]);
  });

  it("closes the audio and runs the pass after teardown, before normalization", async () => {
    transcribeMock.mockResolvedValueOnce("hello world");
    const order: string[] = [];
    let atCall: { recording: boolean; closed: boolean; stopped: boolean } | null =
      null;
    const h = makeHarness({
      settings: { ...speakersOn, normalizerEnabled: true, normalizeLiveOnStop: true },
      assignSpeakers: async () => {
        order.push("speakers");
        atCall = {
          recording: h.registry.isRecording(),
          closed: h.sink.closed,
          stopped: Notice.shown.includes("Live recording stopped."),
        };
      },
      normalize: async () => {
        order.push("normalize");
      },
    });
    await recordOneChunkAndStop(h);

    expect(order).toEqual(["speakers", "normalize"]);
    expect(atCall).toEqual({ recording: false, closed: true, stopped: true });
    expect(h.sink.aborted).toBe(false);
    const [note, source] = h.assignSpeakers.mock.calls[0] as [TFile, LiveSpeakerSource];
    expect(note.path).toBe("Meetings/live.md");
    expect(source.audioPath).toBe(h.sink.path);
    expect(source.lanes).toEqual(["mixed"]);
    // No timestamps from the recognizer: the words are spread over the 15 s window.
    expect(source.words).toEqual([
      { text: "hello", start: 0, end: 7.5, lane: "mixed" },
      { text: "world", start: 7.5, end: 15, lane: "mixed" },
    ]);
  });

  it("discards the audio and skips the pass when nothing was said", async () => {
    const h = makeHarness({ settings: speakersOn });
    await recordOneChunkAndStop(h);
    expect(h.sink.aborted).toBe(true);
    expect(h.sink.closed).toBe(false);
    expect(h.assignSpeakers).not.toHaveBeenCalled();
    expect(h.written).toContainEqual(expect.stringContaining("_No speech detected._"));
  });

  it("skips the pass when the audio file failed, and when it could not be created", async () => {
    transcribeMock.mockResolvedValue("hello world");
    const failed = makeHarness({ settings: speakersOn });
    await openAndStart(failed);
    failed.sink.failed = new Error("disk full");
    feed(failed.world.contexts[0], new Float32Array(16000 * 15));
    await settle();
    failed.buttons().startStop.click();
    await settle();
    expect(failed.sink.aborted).toBe(true);
    expect(failed.assignSpeakers).not.toHaveBeenCalled();
    expect(Notice.shown.some((n) => /could not be saved/.test(n))).toBe(true);
    expect(failed.written).toContainEqual(expect.stringContaining("hello world"));

    const none = makeHarness({ settings: speakersOn, noSink: true });
    await recordOneChunkAndStop(none);
    expect(none.assignSpeakers).not.toHaveBeenCalled();
  });

  it("labels microphone and loopback words Me and Others in time order", async () => {
    const h = makeHarness({ settings: speakersOn });
    await h.panel.onOpen();
    await settle();
    const { source, device } = h.selects();
    source.value = "both";
    device.value = LOOPBACK_DEVICE_ID;
    h.buttons().startStop.click();
    await settle();
    expect(h.world.deps.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.openSink.mock.calls[0][1]).toBe(2);

    const ctx = h.world.contexts[0];
    transcribeWithTimestampsMock
      .mockResolvedValueOnce({
        text: "hi there",
        words: [
          { text: "hi", start: 0, end: 0.5 },
          { text: "there", start: 0.5, end: 1 },
        ],
      })
      .mockResolvedValueOnce({
        text: "hello",
        words: [{ text: "hello", start: 0.2, end: 0.4 }],
      });
    const audible = new Float32Array(16000 * 15).fill(0.1);
    feedLanes(ctx, [new Float32Array(16000 * 15), audible]);
    await settle();
    expect(h.written[0]).toContain(
      "**Me:** hi\n\n**Others:** hello\n\n**Me:** there",
    );
    expect(h.sink.frames[0]).toHaveLength(2);

    // The next window continues the last paragraph when the label matches.
    transcribeWithTimestampsMock
      .mockResolvedValueOnce({
        text: "again",
        words: [{ text: "again", start: 0.1, end: 0.3 }],
      })
      .mockResolvedValueOnce({ text: "", words: [] });
    feedLanes(ctx, [new Float32Array(16000 * 15), audible]);
    await settle();
    expect(h.written[1]).toContain(
      "**Me:** hi\n\n**Others:** hello\n\n**Me:** there again",
    );

    h.buttons().startStop.click();
    await settle();
    const [, sourceArg] = h.assignSpeakers.mock.calls[0] as [TFile, LiveSpeakerSource];
    expect(sourceArg.lanes).toEqual(["me", "others"]);
    expect(sourceArg.words.map((w) => `${w.lane}:${w.text}@${w.start}`)).toEqual([
      "me:hi@0",
      "others:hello@0.2",
      "me:there@0.5",
      "me:again@14.6",
    ]);
  });

  it("skips decoding a silent loopback lane and explains the routing once", async () => {
    const h = makeHarness();
    await h.panel.onOpen();
    await settle();
    const { source, device } = h.selects();
    source.value = "both";
    device.value = LOOPBACK_DEVICE_ID;
    h.buttons().startStop.click();
    await settle();
    const ctx = h.world.contexts[0];
    const silent = new Float32Array(16000 * 15);
    const routing = () =>
      Notice.shown.filter((n) => /No audio has reached/.test(n)).length;

    // Distinct text per window: identical text would look like a seam overlap.
    transcribeMock
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two")
      .mockResolvedValueOnce("three")
      .mockResolvedValue("more");
    feedLanes(ctx, [silent, silent]);
    await settle();
    // Only the microphone lane was decoded; one silent window is not yet a verdict.
    expect(transcribeWithTimestampsMock).toHaveBeenCalledTimes(1);
    expect(routing()).toBe(0);

    feedLanes(ctx, [silent, silent]);
    await settle();
    expect(transcribeWithTimestampsMock).toHaveBeenCalledTimes(2);
    expect(routing()).toBe(1);

    feedLanes(ctx, [silent, silent]);
    await settle();
    expect(routing()).toBe(1); // said once
    expect(h.written[2]).toContain("**Me:** one two three");

    // Sound arriving on the loopback lane is decoded as usual.
    feedLanes(ctx, [silent, new Float32Array(16000 * 15).fill(0.2)]);
    await settle();
    expect(transcribeWithTimestampsMock).toHaveBeenCalledTimes(5);
  });
});

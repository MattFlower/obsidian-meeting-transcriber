import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveSessionRegistry } from "../src/live";
import type { TranscriberSettings } from "../src/settings";
import { feed, makeWorld, type FakeWorld } from "./helpers/fake-audio";
import {
  FakeEl,
  Notice,
  Option,
  TFile,
  WorkspaceLeaf,
} from "./helpers/obsidian-stub";

// Chunk transcription goes through the native sherpa-onnx addon; stub it so
// the test stays headless and can hold a chunk "in flight".
vi.mock("../src/transcriber", () => ({ transcribe: vi.fn() }));

import { transcribe } from "../src/transcriber";
import { LiveRecordingPanel, type LiveRecordingHost } from "../src/live-panel";

const transcribeMock = vi.mocked(transcribe);
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
  vault: { read: ReturnType<typeof vi.fn>; modify: ReturnType<typeof vi.fn> };
  /** The panel's two buttons: start/stop and pause/resume. */
  buttons(): { startStop: FakeEl; pause: FakeEl };
  /** The owner tag the panel used for its status-bar line. */
  owner(): string;
}

interface HarnessOptions {
  registry?: LiveSessionRegistry;
  createNote?: LiveRecordingHost["createNote"];
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const registry = opts.registry ?? new LiveSessionRegistry();
  const world = makeWorld();
  const vault = {
    read: vi.fn(async () => "---\ntitle: live\n---\n\n## Transcript\n"),
    modify: vi.fn(async () => undefined),
  };
  const setStatus = vi.fn();
  const host: LiveRecordingHost = {
    settings: {
      liveChunkSeconds: 15,
      liveAudioSource: "microphone",
    } as TranscriberSettings,
    resolveModelDir: () => "/vault/models",
    resolvePluginDir: () => "/vault/.obsidian/plugins/meeting-transcriber",
    findMissingModelFiles: () => [],
    createNote:
      opts.createNote ??
      (async () => Object.assign(new TFile(), { path: "Meetings/live.md" })),
    setStatus,
    isLiveSessionActive: () => registry.isRecording(),
    claimLiveSession: (panel) => registry.tryClaim(panel),
    releaseLiveSession: (panel) => registry.release(panel),
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
    buttons: () => {
      const [startStop, pause] = content.findAll((el) => el.tag === "button");
      return { startStop, pause };
    },
    owner: () => setStatus.mock.calls[0]?.[0] as string,
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
    expect(h.vault.modify).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("_No speech detected._"),
    );

    // The refresh stops with the session: no more writes, ever.
    h.setStatus.mockClear();
    vi.advanceTimersByTime(5000);
    expect(h.setStatus).not.toHaveBeenCalled();
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
    expect(h.vault.modify).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("hello world"),
    );
    expect(h.setStatus).toHaveBeenLastCalledWith(owner, "● Live recording 00:00");
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
    expect(h.vault.modify).toHaveBeenCalledWith(
      expect.anything(),
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

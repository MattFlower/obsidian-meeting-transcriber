import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_FRAME_SAMPLES,
  CAPTURE_PROCESSOR_NAME,
  CAPTURE_WORKLET_SOURCE,
  LIVE_SAMPLE_RATE,
  isSilent,
  laneLabel,
  lanesForSource,
  LOOPBACK_AUDIO_PROCESSING,
  loopbackLane,
  LiveChunker,
  LiveRecordingSession,
  LiveSessionRegistry,
  spreadWords,
  TranscriptOverlapDeduper,
  type LiveFrame,
  type LiveSessionOwner,
  type LiveWindow,
  SYSTEM_AUDIO_UNAVAILABLE,
} from "../src/live";
import {
  FakeAudioContext,
  feed,
  feedLanes,
  LOOPBACK_DEVICE_ID,
  makeWorld,
  type FakeWorld,
} from "./helpers/fake-audio";

function makeSession(
  world: FakeWorld,
  overrides?: {
    chunkSeconds?: number;
    overlapSeconds?: number;
    sampleRate?: number;
    onChunk?: (pcm: Float32Array) => void;
    onError?: (e: Error) => void;
    clock?: () => number;
  },
): LiveRecordingSession {
  const chunks: Float32Array[] = [];
  const errors: Error[] = [];
  return new LiveRecordingSession(world.deps, {
    chunkSeconds: overrides?.chunkSeconds ?? 1,
    overlapSeconds: overrides?.overlapSeconds ?? 0,
    sampleRate: overrides?.sampleRate ?? 100,
    onWindow: (window) =>
      (overrides?.onChunk ?? ((pcm) => chunks.push(pcm)))(window.lanes.mixed!),
    onError: overrides?.onError ?? ((e) => errors.push(e)),
    clock: overrides?.clock,
  });
}

/**
 * Evaluate the worklet module source headlessly with a stand-in for the
 * AudioWorkletProcessor base class and registerProcessor, and return the
 * processor classes it registered.
 */
function loadWorkletProcessors(): Record<string, new () => FakeProcessor> {
  const registered: Record<string, new () => FakeProcessor> = {};
  new Function("AudioWorkletProcessor", "registerProcessor", CAPTURE_WORKLET_SOURCE)(
    FakeProcessorBase,
    (name: string, cls: new () => FakeProcessor) => {
      registered[name] = cls;
    },
  );
  return registered;
}

class FakeProcessorBase {
  port = {
    messages: [] as Float32Array[],
    transfers: [] as unknown[],
    postMessage(message: Float32Array, transfer?: unknown[]): void {
      this.messages.push(message);
      this.transfers.push(transfer);
    },
  };
}

interface FakeProcessor extends FakeProcessorBase {
  process(inputs: Float32Array[][]): boolean;
}

function quantum(start: number, length = 128): Float32Array {
  return new Float32Array(length).map((_, i) => start + i);
}

// ---------------------------------------------------------------------------

describe("TranscriptOverlapDeduper", () => {
  it("removes duplicated words across a chunk seam", () => {
    const deduper = new TranscriptOverlapDeduper();
    const first = deduper.append("hello world this is");
    const second = deduper.append("this is a test");

    expect(second).toBe("a test");
    expect(`${first} ${second}`).toBe("hello world this is a test");
  });

  it("does not truncate words when consecutive chunks do not overlap", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("hello world");
    expect(deduper.append("goodbye now")).toBe("goodbye now");
  });

  it("returns the first chunk unchanged and reset clears prior state", () => {
    const deduper = new TranscriptOverlapDeduper();
    expect(deduper.append("  First chunk.  ")).toBe("  First chunk.  ");
    deduper.reset();
    expect(deduper.append("First chunk continues")).toBe(
      "First chunk continues",
    );
  });

  it("matches overlap despite case and edge punctuation differences", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("Earlier words, the quick, brown fox");
    expect(deduper.append("The quick brown fox jumps")).toBe("jumps");
  });

  it("replaces a clipped seam word with the fuller recognition", () => {
    const deduper = new TranscriptOverlapDeduper();
    const first = deduper.append("we discussed transcri");
    const second = deduper.append("transcription of the meeting");
    const correction = deduper.takeCorrection();
    const correctedFirst = correction
      ? first.replace(correction.previous, correction.replacement)
      : first;

    expect(second).toBe("of the meeting");
    expect(`${correctedFirst} ${second}`).toBe(
      "we discussed transcription of the meeting",
    );
    expect(`${correctedFirst} ${second}`.match(/transcription/g)).toHaveLength(1);
  });

  it("consumes a chunk that is entirely duplicated", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("one two three four");
    expect(deduper.append("three four")).toBe("");
  });

  it("de-duplicates a chain of overlapping chunks", () => {
    const deduper = new TranscriptOverlapDeduper();
    const emitted = [
      deduper.append("one two three"),
      deduper.append("two three four five"),
      deduper.append("four five six seven"),
    ].filter(Boolean);

    expect(emitted.join(" ")).toBe("one two three four five six seven");
  });

  it("ignores an empty append without changing state", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("hello seam");
    expect(deduper.append("")).toBe("");
    expect(deduper.append("seam continues")).toBe("continues");
  });

  it.each([
    ["we saw a", "and then we left"],
    ["I went to the", "then the store closed"],
    ["she said I", "It was fine"],
    ["meet me in", "into the room"],
    ["please do", "don't forget"],
  ])(
    "keeps a short real seam word instead of treating it as clipped: %j + %j",
    (first, second) => {
      const deduper = new TranscriptOverlapDeduper();
      const emittedFirst = deduper.append(first);
      const emittedSecond = deduper.append(second);

      expect(deduper.takeCorrection()).toBeNull();
      expect(emittedSecond).toBe(second);
      expect(`${emittedFirst} ${emittedSecond}`).toBe(`${first} ${second}`);
    },
  );

  it("keeps a complete short word that merely prefixes the next chunk's first word", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we went with");
    expect(deduper.append("without the others")).toBe("without the others");
    expect(deduper.takeCorrection()).toBeNull();
  });

  it("corrects a short clipped word when an exact-match word anchors the seam", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we saw a");
    const second = deduper.append("saw and then we left");

    expect(deduper.takeCorrection()).toEqual({
      previous: "a",
      replacement: "and",
    });
    expect(second).toBe("then we left");
  });

  it("drops the clipped word's chunk-final punctuation when the next chunk continues", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we discussed transcri.");
    expect(deduper.append("discussed transcription of the meeting")).toBe(
      "of the meeting",
    );
    expect(deduper.takeCorrection()).toEqual({
      previous: "transcri.",
      replacement: "transcription",
    });
  });

  it("keeps the clipped word's sentence punctuation when nothing follows the fuller word", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we discussed transcri.");
    expect(deduper.append("discussed transcription")).toBe("");
    expect(deduper.takeCorrection()).toEqual({
      previous: "transcri.",
      replacement: "transcription.",
    });
  });

  it("prefers the fuller word's own trailing punctuation over the clipped word's", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we discussed transcri.");
    expect(deduper.append("discussed transcription, then the meeting")).toBe(
      "then the meeting",
    );
    expect(deduper.takeCorrection()).toEqual({
      previous: "transcri.",
      replacement: "transcription,",
    });
  });

  it("never carries a clipped connector such as a hyphen onto the fuller word", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we talked about self-");
    expect(deduper.append("self-driving")).toBe("");
    expect(deduper.takeCorrection()).toEqual({
      previous: "self-",
      replacement: "self-driving",
    });
  });

  it("keeps the clipped word's capitalization instead of the chunk-initial capital", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we discussed transcri");
    expect(deduper.append("Transcription of the meeting")).toBe(
      "of the meeting",
    );
    expect(deduper.takeCorrection()).toEqual({
      previous: "transcri",
      replacement: "transcription",
    });

    deduper.reset();
    deduper.append("Transcri");
    deduper.append("transcription of the meeting");
    expect(deduper.takeCorrection()).toEqual({
      previous: "Transcri",
      replacement: "Transcription",
    });
  });

  it("keeps the clipped word's leading punctuation on the replacement", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append('he said "transcri');
    expect(deduper.append("transcription of it")).toBe("of it");
    expect(deduper.takeCorrection()).toEqual({
      previous: '"transcri',
      replacement: '"transcription',
    });
  });

  it("does not treat the next chunk's shorter first word as a clip", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we discussed transcription");
    expect(deduper.append("transcript is done")).toBe("transcript is done");
    expect(deduper.takeCorrection()).toBeNull();

    deduper.reset();
    deduper.append("we didn't");
    expect(deduper.append("we did it anyway")).toBe("we did it anyway");
    expect(deduper.takeCorrection()).toBeNull();
  });

  it("corrects a listed word when an exact-match word anchors the seam", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("we went with");
    expect(deduper.append("went without the others")).toBe("the others");
    expect(deduper.takeCorrection()).toEqual({
      previous: "with",
      replacement: "without",
    });
  });

  it.each([
    ["so we did", "we didn't want to"],
    ["so I do", "I don't know"],
    ["we talked about the end", "the ending was fine"],
  ])(
    "keeps a word plus its suffix apart behind a single anchor: %j + %j",
    (first, second) => {
      const deduper = new TranscriptOverlapDeduper();
      deduper.append(first);
      expect(deduper.append(second)).toBe(second);
      expect(deduper.takeCorrection()).toBeNull();
    },
  );

  it("merges a word plus its suffix when two exact-match words anchor the seam", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("so we could");
    expect(deduper.append("so we couldn't make it")).toBe("make it");
    expect(deduper.takeCorrection()).toEqual({
      previous: "could",
      replacement: "couldn't",
    });
  });

  it.each([
    ["this is the plan.", "Planet Earth is next"],
    ["send me the note.", "notebook sales are up"],
    ["we finished the mark,", "market is open"],
  ])(
    "treats an unanchored word closed by punctuation as complete: %j + %j",
    (first, second) => {
      const deduper = new TranscriptOverlapDeduper();
      deduper.append(first);
      expect(deduper.append(second)).toBe(second);
      expect(deduper.takeCorrection()).toBeNull();
    },
  );

  it("still merges a punctuated fragment when an exact-match word anchors the seam", () => {
    const deduper = new TranscriptOverlapDeduper();
    deduper.append("this is the plan.");
    expect(deduper.append("the planet we chose")).toBe("we chose");
    expect(deduper.takeCorrection()).toEqual({
      previous: "plan.",
      replacement: "planet",
    });
  });

  it.each([
    ["when did it start", "started raining"],
    ["we ran the test", "tests are passing"],
    ["we will meet", "meeting starts now"],
    ["we could", "couldn't make it"],
    ["we need to commit", "committed the change"],
    ["that was the plan", "planned for later"],
  ])(
    "keeps an unanchored word apart from its inflected or contracted form: %j + %j",
    (first, second) => {
      const deduper = new TranscriptOverlapDeduper();
      deduper.append(first);
      expect(deduper.append(second)).toBe(second);
      expect(deduper.takeCorrection()).toBeNull();
    },
  );
});

describe("LiveChunker", () => {
  it("emits nothing until a full chunk has accumulated", () => {
    const c = new LiveChunker({
      sampleRate: 1000,
      chunkSeconds: 2,
      overlapSeconds: 0,
    });
    expect(c.push(new Float32Array(1999))).toEqual([]);
    const out = c.push(new Float32Array(1));
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(2000);
  });

  it("emits exactly floor(total/chunk) chunks and keeps the remainder", () => {
    const c = new LiveChunker({
      sampleRate: 100,
      chunkSeconds: 1,
      overlapSeconds: 0,
    });
    const out = c.push(new Float32Array(250));
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(100);
    expect(out[1].length).toBe(100);
    // The remaining 50 samples (0.5 s) are too short for flush().
    expect(c.flush()).toBeNull();
  });

  it("flush() returns the remainder when it is >= 1 s, null when shorter", () => {
    const c = new LiveChunker({
      sampleRate: 100,
      chunkSeconds: 2,
      overlapSeconds: 0,
    });
    c.push(new Float32Array(200)); // exactly one chunk
    expect(c.flush()).toBeNull(); // buffer now empty
    c.push(new Float32Array(50)); // 0.5 s buffered
    expect(c.flush()).toBeNull(); // < 1 s
    c.push(new Float32Array(100)); // 1.5 s buffered
    const tail = c.flush();
    expect(tail).not.toBeNull();
    expect(tail!.length).toBe(150);
    expect(c.flush()).toBeNull(); // consumed
  });

  it("overlap chunks begin overlapSeconds before the previous chunk ended", () => {
    const c = new LiveChunker({
      sampleRate: 100,
      chunkSeconds: 1,
      overlapSeconds: 0.25,
    });
    const input = new Float32Array(325).map((_, i) => i);
    const out = c.push(input);
    // step = 100 - 25 = 75 -> chunks at offsets 0, 75, 150, 225
    expect(out).toHaveLength(4);
    expect(Array.from(out[0].slice(0, 5))).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(out[1].slice(0, 5))).toEqual([75, 76, 77, 78, 79]);
    expect(Array.from(out[3].slice(0, 5))).toEqual([225, 226, 227, 228, 229]);
    // The overlap tail (25 samples) stays buffered for the next chunk.
    expect(c.push(new Float32Array(0))).toEqual([]);
  });

  it("defaults to a 0.5 s overlap", () => {
    const c = new LiveChunker({ sampleRate: 100, chunkSeconds: 1 });
    const out = c.push(new Float32Array(150).map((_, i) => i));
    // step = 100 - 50 = 50 -> chunks at offsets 0 and 50
    expect(out).toHaveLength(2);
    expect(Array.from(out[1].slice(0, 3))).toEqual([50, 51, 52]);
  });

  it("reset() clears the buffered samples", () => {
    const c = new LiveChunker({
      sampleRate: 100,
      chunkSeconds: 1,
      overlapSeconds: 0,
    });
    c.push(new Float32Array(150));
    c.reset();
    expect(c.flush()).toBeNull();
    expect(c.push(new Float32Array(50))).toEqual([]);
  });
});

describe("LiveRecordingSession", () => {
  it("starts the microphone capture graph at the model sample rate", async () => {
    const world = makeWorld();
    const session = makeSession(world, { sampleRate: 16000 });
    await session.start("microphone");
    expect(world.deps.getUserMedia).toHaveBeenCalledTimes(1);
    expect(world.deps.getDisplayMedia).not.toHaveBeenCalled();
    expect(world.contexts).toHaveLength(1);
    expect(world.contexts[0].sampleRate).toBe(16000);
    expect(session.isRecording()).toBe(true);
    expect(session.isPaused()).toBe(false);
    // Capture node wired into the graph (source -> worklet -> destination).
    expect(world.contexts[0].sourceNode.connectCount).toBe(1);
    expect(world.contexts[0].captureNode.connectCount).toBe(1);
  });

  it("installs the capture worklet in the session's audio context", async () => {
    const world = makeWorld();
    const session = makeSession(world);
    await session.start("microphone");
    expect(world.deps.createCaptureNode).toHaveBeenCalledTimes(1);
    expect(world.deps.createCaptureNode).toHaveBeenCalledWith(
      world.contexts[0],
      1,
    );
    await session.stop();
  });

  it("tears down the stream and context when the worklet cannot be installed", async () => {
    const world = makeWorld({ workletThrows: true });
    const session = makeSession(world);
    await expect(session.start("microphone")).rejects.toThrow(
      /AudioWorklet unavailable/,
    );
    expect(world.micStream.tracks[0].stopped).toBe(true);
    expect(world.contexts[0].closed).toBe(true);
    expect(session.isRecording()).toBe(false);
  });

  it("stops the stream when the audio context cannot be created", async () => {
    const world = makeWorld();
    vi.mocked(world.deps.createAudioContext).mockImplementation(() => {
      throw new Error("AudioContext unavailable");
    });
    const session = makeSession(world);
    await expect(session.start("microphone")).rejects.toThrow(
      /AudioContext unavailable/,
    );
    expect(world.micStream.tracks[0].stopped).toBe(true);
    expect(world.deps.createCaptureNode).not.toHaveBeenCalled();
    expect(session.isRecording()).toBe(false);
  });

  it("fails to start when the audio track ended while the worklet was loading", async () => {
    const world = makeWorld();
    vi.mocked(world.deps.createCaptureNode).mockImplementation(
      async (context) => {
        // The one-shot `ended` event fires during the asynchronous install.
        world.micStream.tracks[0].readyState = "ended";
        return (context as FakeAudioContext).captureNode;
      },
    );
    const session = makeSession(world);
    await expect(session.start("microphone")).rejects.toThrow(
      /ended before recording started/,
    );
    expect(world.micStream.tracks[0].stopped).toBe(true);
    expect(world.contexts[0].closed).toBe(true);
    expect(session.isRecording()).toBe(false);
  });

  it("ignores port messages that are not sample frames", async () => {
    const world = makeWorld();
    const chunks: Float32Array[] = [];
    const session = makeSession(world, {
      sampleRate: 100,
      chunkSeconds: 1,
      onChunk: (pcm) => chunks.push(pcm),
    });
    await session.start("microphone");
    world.contexts[0].captureNode.port.onmessage!({ data: "not audio" });
    world.contexts[0].captureNode.port.onmessage!({ data: [1, 2, 3] });
    expect(chunks).toHaveLength(0);
    feed(world.contexts[0], new Float32Array(100));
    expect(chunks).toHaveLength(1);
    await session.stop();
  });

  it("emits chunks through onChunk as frames arrive", async () => {
    const world = makeWorld();
    const chunks: Float32Array[] = [];
    const session = makeSession(world, {
      sampleRate: 100,
      chunkSeconds: 1,
      onChunk: (pcm) => chunks.push(pcm),
    });
    await session.start("microphone");
    const ctx = world.contexts[0];
    feed(ctx, new Float32Array(100)); // exactly one chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(100);
    feed(ctx, new Float32Array(50)); // half a chunk: nothing yet
    expect(chunks).toHaveLength(1);
    await session.stop();
  });

  it("pause() drops frames and disables tracks; resume() restores both", async () => {
    const world = makeWorld();
    const chunks: Float32Array[] = [];
    const session = makeSession(world, {
      sampleRate: 100,
      chunkSeconds: 1,
      onChunk: (pcm) => chunks.push(pcm),
    });
    await session.start("microphone");
    const ctx = world.contexts[0];
    const track = world.micStream.tracks[0];

    feed(ctx, new Float32Array(100));
    expect(chunks).toHaveLength(1);

    session.pause();
    expect(session.isPaused()).toBe(true);
    expect(track.enabled).toBe(false);
    feed(ctx, new Float32Array(100)); // dropped while paused
    expect(chunks).toHaveLength(1);

    session.resume();
    expect(session.isPaused()).toBe(false);
    expect(track.enabled).toBe(true);
    feed(ctx, new Float32Array(100));
    expect(chunks).toHaveLength(2);

    await session.stop();
  });

  it("keeps buffered samples across a pause so chunking continues on resume", async () => {
    const world = makeWorld();
    const chunks: Float32Array[] = [];
    const session = makeSession(world, {
      sampleRate: 100,
      chunkSeconds: 1,
      onChunk: (pcm) => chunks.push(pcm),
    });
    await session.start("microphone");
    const ctx = world.contexts[0];
    feed(ctx, new Float32Array(60)); // 0.6 s buffered
    session.pause();
    feed(ctx, new Float32Array(1000)); // dropped
    session.resume();
    feed(ctx, new Float32Array(40)); // 0.6 s + 0.4 s = one full chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(100);
    await session.stop();
  });

  it("stop() stops all tracks, closes the context, and returns the flushed tail", async () => {
    const world = makeWorld();
    const session = makeSession(world, { sampleRate: 100, chunkSeconds: 2 });
    await session.start("microphone");
    const ctx = world.contexts[0];
    feed(ctx, new Float32Array(200)); // one full chunk
    feed(ctx, new Float32Array(120)); // 1.2 s tail (>= 1 s: flushed)

    const tail = await session.stop();

    expect(tail).not.toBeNull();
    expect(tail!.lanes.mixed!.length).toBe(120);
    expect(world.micStream.tracks[0].stopped).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(ctx.captureNode.disconnectCount).toBe(1);
    expect(ctx.captureNode.port.closed).toBe(true);
    expect(ctx.captureNode.port.onmessage).toBeNull();
    expect(session.isRecording()).toBe(false);
    // Stopping again is a no-op.
    expect(await session.stop()).toBeNull();
  });

  it("stop() returns null when the remaining buffer is under one second", async () => {
    const world = makeWorld();
    const session = makeSession(world, { sampleRate: 100, chunkSeconds: 2 });
    await session.start("microphone");
    const ctx = world.contexts[0];
    feed(ctx, new Float32Array(80)); // 0.8 s: too short to flush
    const tail = await session.stop();
    expect(tail).toBeNull();
  });

  it("elapsedSeconds() accumulates unpaused time only", async () => {
    let now = 1000;
    const world = makeWorld();
    const session = makeSession(world, {
      sampleRate: 100,
      clock: () => now,
    });
    await session.start("microphone");
    now = 4000;
    session.pause();
    now = 9000;
    expect(session.elapsedSeconds()).toBe(3); // frozen while paused
    session.resume();
    now = 12000;
    expect(session.elapsedSeconds()).toBe(6); // 3 s + 3 s unpaused
    await session.stop();
  });

  it("start('system') uses the screen-share audio track when present", async () => {
    const world = makeWorld({ displayAudio: true });
    const session = makeSession(world);
    await session.start("system");
    expect(world.deps.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(world.deps.getUserMedia).not.toHaveBeenCalled();
    // The shared video track is stopped; the audio track is kept.
    const [video, audio] = world.displayStream.tracks;
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(false);
    expect(session.isRecording()).toBe(true);
    await session.stop();
  });

  it("start('system') throws the loopback error when screen share has no audio track", async () => {
    const world = makeWorld({ displayAudio: false });
    const session = makeSession(world);
    await expect(session.start("system")).rejects.toThrow(
      /loopback/i,
    );
    await expect(session.start("system")).rejects.toThrow(
      SYSTEM_AUDIO_UNAVAILABLE,
    );
    // The microphone path is never touched — no silent fallback.
    expect(world.deps.getUserMedia).not.toHaveBeenCalled();
    expect(world.micStream.tracks[0].stopped).toBe(false);
    expect(session.isRecording()).toBe(false);
  });

  it("start('system') treats a declined screen-share prompt as unavailable", async () => {
    const world = makeWorld({ displayThrows: true });
    const session = makeSession(world);
    await expect(session.start("system")).rejects.toThrow(
      SYSTEM_AUDIO_UNAVAILABLE,
    );
    expect(world.deps.getUserMedia).not.toHaveBeenCalled();
  });

  it("start('system', deviceId) captures the selected loopback input device", async () => {
    const world = makeWorld({ displayAudio: false });
    const session = makeSession(world);
    await session.start("system", "loopback-device-123");
    expect(world.deps.getUserMedia).toHaveBeenCalledTimes(1);
    expect(world.deps.getDisplayMedia).not.toHaveBeenCalled();
    const constraint = world.deps.getUserMedia.mock.calls[0][0];
    expect(constraint.audio).toEqual({
      deviceId: { exact: "loopback-device-123" },
      ...LOOPBACK_AUDIO_PROCESSING,
    });
    expect(session.isRecording()).toBe(true);
    await session.stop();
  });

  it("refuses to start a second session while one is active", async () => {
    const world = makeWorld();
    const session = makeSession(world);
    await session.start("microphone");
    await expect(session.start("microphone")).rejects.toThrow(
      /already active/i,
    );
    await session.stop();
  });

  it("refuses a concurrent start() while the first is still setting up", async () => {
    const world = makeWorld();
    let finishWorklet!: () => void;
    const workletReady = new Promise<void>((resolve) => {
      finishWorklet = resolve;
    });
    vi.mocked(world.deps.createCaptureNode).mockImplementation(
      async (context) => {
        await workletReady;
        return (context as FakeAudioContext).captureNode;
      },
    );
    const session = makeSession(world);
    const first = session.start("microphone");
    await expect(session.start("microphone")).rejects.toThrow(
      /already active/i,
    );
    finishWorklet();
    await first;
    expect(session.isRecording()).toBe(true);
    expect(world.deps.getUserMedia).toHaveBeenCalledTimes(1);
    expect(world.contexts).toHaveLength(1);
    await session.stop();
    // The flag is cleared on completion, so a fresh start works again.
    await session.start("microphone");
    expect(session.isRecording()).toBe(true);
    await session.stop();
  });

  it("reports an error and stops when the input track ends mid-session", async () => {
    const world = makeWorld();
    const errors: Error[] = [];
    const session = makeSession(world, {
      onError: (e) => errors.push(e),
    });
    await session.start("microphone");
    world.micStream.tracks[0].onended!();
    expect(errors).toHaveLength(1);
    expect(/ended unexpectedly/i.test(errors[0].message)).toBe(true);
    await session.stop();
  });

  it("uses the default 16 kHz model sample rate when none is given", async () => {
    const world = makeWorld();
    const session = new LiveRecordingSession(world.deps, {
      onWindow: () => undefined,
      onError: () => undefined,
    });
    await session.start("microphone");
    expect(world.contexts[0].sampleRate).toBe(LIVE_SAMPLE_RATE);
    await session.stop();
  });
});

describe("LiveSessionRegistry", () => {
  class FakeOwner implements LiveSessionOwner {
    recording = false;
    isRecording(): boolean {
      return this.recording;
    }
  }

  it("allows a claim when no session is active", () => {
    const reg = new LiveSessionRegistry();
    const a = new FakeOwner();
    expect(reg.tryClaim(a)).toBe(true);
    expect(reg.isRecording()).toBe(false); // claimed but not recording yet
  });

  it("refuses a second claim while the first owner is recording", () => {
    const reg = new LiveSessionRegistry();
    const a = new FakeOwner();
    const b = new FakeOwner();
    expect(reg.tryClaim(a)).toBe(true);
    a.recording = true;
    expect(reg.isRecording()).toBe(true);
    // A second owner is refused while the first is recording…
    expect(reg.tryClaim(b)).toBe(false);
    // …but the same owner may re-claim (idempotent).
    expect(reg.tryClaim(a)).toBe(true);
    expect(reg.isRecording()).toBe(true);
  });

  it("allows a new claim once the recording owner releases", () => {
    const reg = new LiveSessionRegistry();
    const a = new FakeOwner();
    const b = new FakeOwner();
    reg.tryClaim(a);
    a.recording = true;
    reg.release(a);
    expect(reg.isRecording()).toBe(false);
    expect(reg.tryClaim(b)).toBe(true);
    b.recording = true;
    expect(reg.isRecording()).toBe(true);
  });

  it("refuses a second claim while the first owner is still starting", () => {
    const reg = new LiveSessionRegistry();
    const a = new FakeOwner();
    const b = new FakeOwner();
    reg.tryClaim(a); // claimed but permission/start is still pending
    expect(reg.isRecording()).toBe(false);
    expect(reg.tryClaim(b)).toBe(false);
    a.recording = true;
    expect(reg.isRecording()).toBe(true);
  });

  it("release() is a no-op for an owner that does not hold the slot", () => {
    const reg = new LiveSessionRegistry();
    const a = new FakeOwner();
    const b = new FakeOwner();
    reg.tryClaim(a);
    a.recording = true;
    reg.release(b); // b never claimed: must be ignored
    expect(reg.isRecording()).toBe(true); // a still holds the slot
    reg.release(a);
    expect(reg.isRecording()).toBe(false);
  });

  it("keeps the slot until the stopped owner releases it", () => {
    const reg = new LiveSessionRegistry();
    const a = new FakeOwner();
    reg.tryClaim(a);
    a.recording = true;
    expect(reg.isRecording()).toBe(true);
    a.recording = false; // session stopped, release pending
    expect(reg.isRecording()).toBe(false);
    const b = new FakeOwner();
    expect(reg.tryClaim(b)).toBe(false);
    reg.release(a);
    expect(reg.tryClaim(b)).toBe(true);
    b.recording = true;
    expect(reg.isRecording()).toBe(true);
  });
});

describe("CAPTURE_WORKLET_SOURCE", () => {
  it("registers the capture processor under CAPTURE_PROCESSOR_NAME", () => {
    const processors = loadWorkletProcessors();
    expect(Object.keys(processors)).toEqual([CAPTURE_PROCESSOR_NAME]);
  });

  it("posts one transferred frame once enough render quanta arrive", () => {
    const Processor = loadWorkletProcessors()[CAPTURE_PROCESSOR_NAME];
    const processor = new Processor();
    const quantaPerFrame = CAPTURE_FRAME_SAMPLES / 128;

    for (let i = 0; i < quantaPerFrame - 1; i++) {
      expect(processor.process([[quantum(i * 128)]])).toBe(true);
    }
    expect(processor.port.messages).toHaveLength(0);

    processor.process([[quantum((quantaPerFrame - 1) * 128)]]);
    expect(processor.port.messages).toHaveLength(1);
    const frame = processor.port.messages[0];
    expect(frame.length).toBe(CAPTURE_FRAME_SAMPLES);
    expect(frame[0]).toBe(0);
    expect(frame[CAPTURE_FRAME_SAMPLES - 1]).toBe(CAPTURE_FRAME_SAMPLES - 1);
    // The frame's buffer is transferred, and the next frame is a fresh one.
    expect(processor.port.transfers[0]).toEqual([frame.buffer]);
    for (let i = 0; i < quantaPerFrame; i++) {
      processor.process([[quantum(CAPTURE_FRAME_SAMPLES + i * 128)]]);
    }
    expect(processor.port.messages).toHaveLength(2);
    expect(processor.port.messages[1]).not.toBe(frame);
    expect(processor.port.messages[1][0]).toBe(CAPTURE_FRAME_SAMPLES);
  });

  it("splits a quantum that straddles a frame boundary without losing samples", () => {
    const Processor = loadWorkletProcessors()[CAPTURE_PROCESSOR_NAME];
    const processor = new Processor();
    const odd = 100; // does not divide the frame size
    let sample = 0;
    while (processor.port.messages.length < 2) {
      processor.process([[quantum(sample, odd)]]);
      sample += odd;
    }
    const [first, second] = processor.port.messages;
    expect(Array.from(first)).toEqual(
      Array.from({ length: CAPTURE_FRAME_SAMPLES }, (_, i) => i),
    );
    expect(second[0]).toBe(CAPTURE_FRAME_SAMPLES);
    expect(second[CAPTURE_FRAME_SAMPLES - 1]).toBe(2 * CAPTURE_FRAME_SAMPLES - 1);
  });

  it("keeps running when the input has no channel yet", () => {
    const Processor = loadWorkletProcessors()[CAPTURE_PROCESSOR_NAME];
    const processor = new Processor();
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(processor.port.messages).toHaveLength(0);
  });
});

describe("LiveRecordingSession windows and lanes", () => {
  it("numbers windows and places them on the timeline by the chunk step", async () => {
    const world = makeWorld();
    const windows: LiveWindow[] = [];
    const session = new LiveRecordingSession(world.deps, {
      sampleRate: 100,
      chunkSeconds: 1,
      overlapSeconds: 0.25,
      onWindow: (window) => windows.push(window),
      onError: () => undefined,
    });
    await session.start("microphone");
    expect(session.getLanes()).toEqual(["mixed"]);
    // 175 samples: chunk 0 at 0, chunk 1 at the 75-sample step (0.75 s).
    feed(world.contexts[0], new Float32Array(175));
    expect(windows.map((w) => w.index)).toEqual([0, 1]);
    expect(windows.map((w) => w.startSeconds)).toEqual([0, 0.75]);
    expect(Object.keys(windows[1].lanes)).toEqual(["mixed"]);
    expect(windows[1].lanes.mixed!.length).toBe(100);
    expect(await session.stop()).toBeNull(); // 25 samples left: under 1 s
  });

  it("reports every unpaused frame to onFrame before chunking", async () => {
    const world = makeWorld();
    const frames: LiveFrame[] = [];
    const windows: LiveWindow[] = [];
    const session = new LiveRecordingSession(world.deps, {
      sampleRate: 100,
      chunkSeconds: 1,
      overlapSeconds: 0,
      onWindow: (window) => windows.push(window),
      onFrame: (frame) => {
        // Frames precede the window they complete.
        frames.push(frame);
        expect(windows).toHaveLength(0);
      },
      onError: () => undefined,
    });
    await session.start("microphone");
    const ctx = world.contexts[0];
    feed(ctx, new Float32Array(30));
    session.pause();
    feed(ctx, new Float32Array(30)); // dropped, never reported
    session.resume();
    feed(ctx, new Float32Array(30));
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.mixed!.length)).toEqual([30, 30]);
    await session.stop();
  });

  it("captures microphone and loopback as sample-aligned lanes when both are selected", async () => {
    const world = makeWorld();
    const windows: LiveWindow[] = [];
    const frames: LiveFrame[] = [];
    const session = new LiveRecordingSession(world.deps, {
      sampleRate: 100,
      chunkSeconds: 1,
      overlapSeconds: 0,
      onWindow: (window) => windows.push(window),
      onFrame: (frame) => frames.push(frame),
      onError: () => undefined,
    });
    await session.start("both", LOOPBACK_DEVICE_ID, "mic-1");
    expect(session.getLanes()).toEqual(["me", "others"]);
    expect(world.deps.getUserMedia).toHaveBeenCalledTimes(2);
    expect(world.deps.getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { deviceId: { exact: "mic-1" } },
      video: false,
    });
    expect(world.deps.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: { deviceId: { exact: LOOPBACK_DEVICE_ID }, ...LOOPBACK_AUDIO_PROCESSING },
      video: false,
    });
    expect(world.deps.getDisplayMedia).not.toHaveBeenCalled();

    const ctx = world.contexts[0];
    expect(world.deps.createCaptureNode).toHaveBeenCalledWith(ctx, 2);
    expect(ctx.sourceNodes).toHaveLength(2);
    expect(ctx.sourceNodes[0].stream).toBe(world.micStream);
    expect(ctx.sourceNodes[1].stream).toBe(world.loopbackStream);
    expect(ctx.sourceNodes[0].connections[0].input).toBe(0);
    expect(ctx.sourceNodes[1].connections[0].input).toBe(1);

    const me = new Float32Array(100).fill(0.1);
    const others = new Float32Array(100).fill(0.2);
    feedLanes(ctx, [me, others]);
    expect(frames).toHaveLength(1);
    expect(frames[0].me).toBe(me);
    expect(windows).toHaveLength(1);
    expect(windows[0].lanes.me![0]).toBeCloseTo(0.1);
    expect(windows[0].lanes.others![0]).toBeCloseTo(0.2);

    // A bare mono frame is not a valid message for a two-lane session.
    feed(ctx, new Float32Array(100));
    expect(windows).toHaveLength(1);

    session.pause();
    expect(world.micStream.tracks[0].enabled).toBe(false);
    expect(world.loopbackStream.tracks[0].enabled).toBe(false);
    session.resume();
    expect(world.loopbackStream.tracks[0].enabled).toBe(true);

    feedLanes(ctx, [new Float32Array(120), new Float32Array(120)]);
    expect(windows).toHaveLength(2);
    expect(windows[1].startSeconds).toBe(1);

    expect(await session.stop()).toBeNull(); // 20 samples left in each lane
    expect(world.micStream.tracks[0].stopped).toBe(true);
    expect(world.loopbackStream.tracks[0].stopped).toBe(true);
  });

  it("returns both lanes' tails in the final window", async () => {
    const world = makeWorld();
    const session = new LiveRecordingSession(world.deps, {
      sampleRate: 100,
      chunkSeconds: 2,
      overlapSeconds: 0,
      onWindow: () => undefined,
      onError: () => undefined,
    });
    await session.start("both", LOOPBACK_DEVICE_ID);
    feedLanes(world.contexts[0], [new Float32Array(320), new Float32Array(320)]);
    const tail = await session.stop();
    expect(tail).not.toBeNull();
    expect(tail!.index).toBe(1);
    expect(tail!.startSeconds).toBe(2);
    expect(tail!.lanes.me!.length).toBe(120);
    expect(tail!.lanes.others!.length).toBe(120);
  });

  it("releases the microphone when the loopback device cannot be opened", async () => {
    const world = makeWorld();
    vi.mocked(world.deps.getUserMedia)
      .mockImplementationOnce(async () => world.micStream)
      .mockImplementationOnce(async () => {
        throw new Error("NotFoundError");
      });
    const session = makeSession(world);
    await expect(session.start("both", "gone")).rejects.toThrow(/NotFoundError/);
    expect(world.micStream.tracks[0].stopped).toBe(true);
    expect(world.contexts).toHaveLength(0);
    expect(session.isRecording()).toBe(false);
  });

  it("falls back to screen-share audio for the loopback lane without a device", async () => {
    const world = makeWorld({ displayAudio: false });
    const session = makeSession(world);
    await expect(session.start("both")).rejects.toThrow(SYSTEM_AUDIO_UNAVAILABLE);
    expect(world.micStream.tracks[0].stopped).toBe(true);
  });
});

describe("lane helpers", () => {
  it("names the lanes of each source and labels them", () => {
    expect(lanesForSource("microphone")).toEqual(["mixed"]);
    expect(lanesForSource("system")).toEqual(["mixed"]);
    expect(lanesForSource("both")).toEqual(["me", "others"]);
    expect(laneLabel("me")).toBe("Me");
    expect(laneLabel("others")).toBe("Others");
    expect(laneLabel("mixed")).toBe("");
  });

  it("names the loopback lane of each source", () => {
    expect(loopbackLane("microphone")).toBeNull();
    expect(loopbackLane("system")).toBe("mixed");
    expect(loopbackLane("both")).toBe("others");
  });

  it("isSilent is true only for digital silence", () => {
    expect(isSilent(new Float32Array(100))).toBe(true);
    const faint = new Float32Array(100);
    faint[50] = 0.00005;
    expect(isSilent(faint)).toBe(true);
    faint[51] = -0.001;
    expect(isSilent(faint)).toBe(false);
    expect(isSilent(new Float32Array(0))).toBe(true);
  });

  it("spreadWords spaces the words evenly over the chunk", () => {
    expect(spreadWords("a  b c d", 2)).toEqual([
      { text: "a", start: 0, end: 0.5 },
      { text: "b", start: 0.5, end: 1 },
      { text: "c", start: 1, end: 1.5 },
      { text: "d", start: 1.5, end: 2 },
    ]);
    expect(spreadWords("   ", 2)).toEqual([]);
  });
});

describe("TranscriptOverlapDeduper.appendWords", () => {
  it("drops the words the previous chunk already emitted and keeps their payload", () => {
    const d = new TranscriptOverlapDeduper();
    const first = d.appendWords([
      { text: "we", t: 1 },
      { text: "will", t: 2 },
      { text: "start", t: 3 },
    ]);
    expect(first.map((w) => w.t)).toEqual([1, 2, 3]);
    const second = d.appendWords([
      { text: "will", t: 4 },
      { text: "start", t: 5 },
      { text: "now", t: 6 },
    ]);
    expect(second).toEqual([{ text: "now", t: 6 }]);
    expect(d.takeCorrection()).toBeNull();
  });

  it("reports a clipped-word correction exactly as append() does", () => {
    const d = new TranscriptOverlapDeduper();
    d.appendWords([{ text: "we" }, { text: "will" }, { text: "transcri" }]);
    const out = d.appendWords([
      { text: "will" },
      { text: "transcription" },
      { text: "now" },
    ]);
    expect(out.map((w) => w.text)).toEqual(["now"]);
    expect(d.takeCorrection()).toEqual({
      previous: "transcri",
      replacement: "transcription",
    });
  });

  it("shares its tail between the text and word forms", () => {
    const d = new TranscriptOverlapDeduper();
    expect(d.append("one two three")).toBe("one two three");
    expect(d.appendWords([{ text: "two" }, { text: "three" }, { text: "four" }])).toEqual([
      { text: "four" },
    ]);
  });
});

describe("CAPTURE_WORKLET_SOURCE with two inputs", () => {
  it("posts both lanes together, cut from the same quanta and transferred", () => {
    const Processor = loadWorkletProcessors()[CAPTURE_PROCESSOR_NAME];
    const processor = new Processor();
    const quantaPerFrame = CAPTURE_FRAME_SAMPLES / 128;
    for (let i = 0; i < quantaPerFrame; i++) {
      processor.process([[quantum(i * 128)], [quantum(1000 + i * 128)]]);
    }
    expect(processor.port.messages).toHaveLength(1);
    const message = processor.port.messages[0] as unknown as {
      lanes: Float32Array[];
    };
    expect(message.lanes).toHaveLength(2);
    expect(message.lanes[0][0]).toBe(0);
    expect(message.lanes[0][CAPTURE_FRAME_SAMPLES - 1]).toBe(CAPTURE_FRAME_SAMPLES - 1);
    expect(message.lanes[1][0]).toBe(1000);
    expect(message.lanes[1][CAPTURE_FRAME_SAMPLES - 1]).toBe(
      1000 + CAPTURE_FRAME_SAMPLES - 1,
    );
    expect(processor.port.transfers[0]).toEqual([
      message.lanes[0].buffer,
      message.lanes[1].buffer,
    ]);
  });

  it("fills an input with nothing connected with silence", () => {
    const Processor = loadWorkletProcessors()[CAPTURE_PROCESSOR_NAME];
    const processor = new Processor();
    const quantaPerFrame = CAPTURE_FRAME_SAMPLES / 128;
    for (let i = 0; i < quantaPerFrame; i++) {
      processor.process([[quantum(1 + i * 128)], []]);
    }
    const message = processor.port.messages[0] as unknown as {
      lanes: Float32Array[];
    };
    expect(message.lanes[0][0]).toBe(1);
    expect(message.lanes[1].every((v) => v === 0)).toBe(true);
    expect(message.lanes[1].length).toBe(CAPTURE_FRAME_SAMPLES);
  });
});

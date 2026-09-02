import { describe, expect, it } from "vitest";
import {
  LIVE_SAMPLE_RATE,
  LiveChunker,
  LiveRecordingSession,
  LiveSessionRegistry,
  TranscriptOverlapDeduper,
  type LiveSessionOwner,
  SYSTEM_AUDIO_UNAVAILABLE,
} from "../src/live";
import { feed, makeWorld, type FakeWorld } from "./helpers/fake-audio";

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
    onChunk: overrides?.onChunk ?? ((pcm) => chunks.push(pcm)),
    onError: overrides?.onError ?? ((e) => errors.push(e)),
    clock: overrides?.clock,
  });
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
    // Processor wired into the graph (source -> processor -> destination).
    expect(world.contexts[0].sourceNode.connectCount).toBe(1);
    expect(world.contexts[0].processor.connectCount).toBe(1);
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
    expect(tail!.length).toBe(120);
    expect(world.micStream.tracks[0].stopped).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(ctx.processor.disconnectCount).toBe(1);
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
    expect(constraint.audio).toEqual({ deviceId: { exact: "loopback-device-123" } });
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
      onChunk: () => undefined,
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

import { vi } from "vitest";

import type { LiveAudioContextLike, LiveCaptureDeps } from "../../src/live";

// ---------------------------------------------------------------------------
// Fakes for the Web Audio / MediaStream surface (headless: no DOM). Shared by
// the session tests and the live panel tests.
// ---------------------------------------------------------------------------

export class FakeTrack {
  enabled = true;
  stopped = false;
  onended: (() => void) | null = null;
  kind: string;

  constructor(kind: string) {
    this.kind = kind;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeStream {
  tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }

  getTracks(): FakeTrack[] {
    return this.tracks;
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

export class FakeCapturePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }
}

/** Stands in for the AudioWorkletNode the session captures through. */
export class FakeCaptureNode {
  port = new FakeCapturePort();
  connectCount = 0;
  disconnectCount = 0;

  connect(): void {
    this.connectCount++;
  }

  disconnect(): void {
    this.disconnectCount++;
  }
}

export class FakeSourceNode {
  connectCount = 0;

  connect(): void {
    this.connectCount++;
  }

  disconnect(): void {
    // no-op
  }
}

export class FakeAudioContext {
  sampleRate: number;
  captureNode = new FakeCaptureNode();
  sourceNode = new FakeSourceNode();
  closed = false;
  destination = {};

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  createMediaStreamSource(_stream: unknown): FakeSourceNode {
    return this.sourceNode;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeWorld {
  deps: LiveCaptureDeps;
  micStream: FakeStream;
  displayStream: FakeStream;
  contexts: FakeAudioContext[];
}

export function makeWorld(opts?: {
  displayAudio?: boolean;
  displayThrows?: boolean;
  workletThrows?: boolean;
}): FakeWorld {
  const micStream = new FakeStream([new FakeTrack("audio")]);
  const displayStream = new FakeStream([
    new FakeTrack("video"),
    ...(opts?.displayAudio === false ? [] : [new FakeTrack("audio")]),
  ]);
  const contexts: FakeAudioContext[] = [];
  const deps: LiveCaptureDeps = {
    getUserMedia: vi.fn(async () => micStream),
    getDisplayMedia: opts?.displayThrows
      ? vi.fn(async () => {
          throw new Error("Permission denied");
        })
      : vi.fn(async () => displayStream),
    enumerateDevices: vi.fn(async () => []),
    createAudioContext: vi.fn((rate: number) => {
      const ctx = new FakeAudioContext(rate);
      contexts.push(ctx);
      return ctx;
    }),
    createCaptureNode: opts?.workletThrows
      ? vi.fn(async () => {
          throw new Error("AudioWorklet unavailable");
        })
      : vi.fn(
          async (context: LiveAudioContextLike) =>
            (context as FakeAudioContext).captureNode,
        ),
  };
  return { deps, micStream, displayStream, contexts };
}

/** Deliver one frame of samples through the fake capture node's port. */
export function feed(ctx: FakeAudioContext, samples: Float32Array): void {
  ctx.captureNode.port.onmessage!({ data: samples });
}

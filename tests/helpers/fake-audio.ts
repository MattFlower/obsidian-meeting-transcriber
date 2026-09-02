import { vi } from "vitest";

import type { LiveCaptureDeps } from "../../src/live";

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

export class FakeScriptProcessor {
  onaudioprocess:
    | ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void)
    | null = null;
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
  processor = new FakeScriptProcessor();
  sourceNode = new FakeSourceNode();
  closed = false;
  destination = {};

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  createMediaStreamSource(_stream: unknown): FakeSourceNode {
    return this.sourceNode;
  }

  createScriptProcessor(): FakeScriptProcessor {
    return this.processor;
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
  };
  return { deps, micStream, displayStream, contexts };
}

/** Push one frame of samples through the fake script processor. */
export function feed(ctx: FakeAudioContext, samples: Float32Array): void {
  ctx.processor.onaudioprocess!({
    inputBuffer: { getChannelData: () => samples },
  });
}

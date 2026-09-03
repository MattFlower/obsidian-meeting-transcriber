import { vi } from "vitest";

import type { LiveAudioContextLike, LiveCaptureDeps } from "../../src/live";

// ---------------------------------------------------------------------------
// Fakes for the Web Audio / MediaStream surface (headless: no DOM). Shared by
// the session tests and the live panel tests.
// ---------------------------------------------------------------------------

export class FakeTrack {
  enabled = true;
  readyState: "live" | "ended" = "live";
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
  /** Every connect() call: the target node and the worklet input index. */
  connections: { target: unknown; output?: number; input?: number }[] = [];
  stream: unknown;

  constructor(stream?: unknown) {
    this.stream = stream;
  }

  connect(target: unknown, output?: number, input?: number): void {
    this.connectCount++;
    this.connections.push({ target, output, input });
  }

  disconnect(): void {
    // no-op
  }
}

export class FakeAudioContext {
  sampleRate: number;
  captureNode = new FakeCaptureNode();
  /** One node per createMediaStreamSource() call, in order. */
  sourceNodes: FakeSourceNode[] = [];
  closed = false;
  destination = {};

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** The first (for a single-source session, the only) source node. */
  get sourceNode(): FakeSourceNode {
    return this.sourceNodes[0];
  }

  createMediaStreamSource(stream: unknown): FakeSourceNode {
    const node = new FakeSourceNode(stream);
    this.sourceNodes.push(node);
    return node;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeWorld {
  deps: LiveCaptureDeps;
  micStream: FakeStream;
  /** Returned by getUserMedia for the device id `LOOPBACK_DEVICE_ID`. */
  loopbackStream: FakeStream;
  displayStream: FakeStream;
  contexts: FakeAudioContext[];
}

/** Device id that makes the fake getUserMedia hand out `loopbackStream`. */
export const LOOPBACK_DEVICE_ID = "loopback";

function wantsLoopback(constraints: MediaStreamConstraints): boolean {
  const audio = constraints.audio;
  if (typeof audio !== "object" || audio === null) return false;
  const deviceId = (audio as MediaTrackConstraints).deviceId;
  return (
    typeof deviceId === "object" &&
    deviceId !== null &&
    (deviceId as ConstrainDOMStringParameters).exact === LOOPBACK_DEVICE_ID
  );
}

export function makeWorld(opts?: {
  displayAudio?: boolean;
  displayThrows?: boolean;
  workletThrows?: boolean;
}): FakeWorld {
  const micStream = new FakeStream([new FakeTrack("audio")]);
  const loopbackStream = new FakeStream([new FakeTrack("audio")]);
  const displayStream = new FakeStream([
    new FakeTrack("video"),
    ...(opts?.displayAudio === false ? [] : [new FakeTrack("audio")]),
  ]);
  const contexts: FakeAudioContext[] = [];
  const deps: LiveCaptureDeps = {
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) =>
      wantsLoopback(constraints) ? loopbackStream : micStream,
    ),
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
  return { deps, micStream, loopbackStream, displayStream, contexts };
}

/** Deliver one frame of samples through the fake capture node's port. */
export function feed(ctx: FakeAudioContext, samples: Float32Array): void {
  ctx.captureNode.port.onmessage!({ data: samples });
}

/** Deliver one two-lane frame (`{ lanes: [me, others] }`) through the port. */
export function feedLanes(ctx: FakeAudioContext, lanes: Float32Array[]): void {
  ctx.captureNode.port.onmessage!({ data: { lanes } });
}

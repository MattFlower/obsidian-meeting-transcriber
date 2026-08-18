/**
 * Live meeting recording: capture microphone or system audio with the Web
 * Audio API, cut the PCM into fixed-length chunks, and hand each finished
 * chunk to a callback (the modal transcribes it with the existing offline
 * Parakeet recognizer and appends the text to the note).
 *
 * This module is framework-free: Obsidian/DOM APIs are injected through
 * `LiveCaptureDeps` so the session logic stays unit-testable headlessly.
 * No native modules are imported here — `transcribe()` (which lazily
 * requires `sherpa-onnx-node`) lives in the modal's pump.
 */

export type LiveAudioSource = "microphone" | "system";

/** Sample rate the Parakeet model expects; capture is done at this rate. */
export const LIVE_SAMPLE_RATE = 16000;

/** Error message fragment callers can match on for the loopback guidance. */
export const SYSTEM_AUDIO_UNAVAILABLE =
  "System audio is not available directly on this platform";

export interface LiveChunkerOptions {
  sampleRate: number;
  chunkSeconds: number;
  /**
   * Seconds of overlap between consecutive chunks (default 0.5). Each
   * emitted chunk begins `overlapSeconds` before the previous chunk ended,
   * so words split at a boundary are still recognized. Words duplicated at
   * the seams are accepted — there is no de-duplication.
   */
  overlapSeconds?: number;
}

/**
 * Buffers incoming mono PCM samples and emits full fixed-length chunks.
 * Pure (no I/O) so it can be unit-tested.
 */
export class LiveChunker {
  private readonly sampleRate: number;
  private readonly chunkSamples: number;
  private readonly overlapSamples: number;
  private readonly minFlushSamples: number;
  private buffer: Float32Array = new Float32Array(0);

  constructor(opts: LiveChunkerOptions) {
    this.sampleRate = opts.sampleRate;
    this.chunkSamples = Math.max(1, Math.round(opts.chunkSeconds * opts.sampleRate));
    const overlap = Math.round((opts.overlapSeconds ?? 0.5) * opts.sampleRate);
    // Clamp so the chunk window always advances.
    this.overlapSamples = Math.min(Math.max(0, overlap), this.chunkSamples - 1);
    this.minFlushSamples = Math.max(1, opts.sampleRate); // 1 second
  }

  /**
   * Append `samples` to the buffer and return zero or more full chunks. With
   * overlap, chunk N+1 starts `overlapSamples` before chunk N ended.
   */
  push(samples: Float32Array): Float32Array[] {
    if (samples.length === 0) return [];
    const next = new Float32Array(this.buffer.length + samples.length);
    next.set(this.buffer);
    next.set(samples, this.buffer.length);
    this.buffer = next;

    const chunks: Float32Array[] = [];
    const step = this.chunkSamples - this.overlapSamples;
    let offset = 0;
    while (this.buffer.length - offset >= this.chunkSamples) {
      chunks.push(this.buffer.slice(offset, offset + this.chunkSamples));
      offset += step;
    }
    if (offset > 0) {
      this.buffer = this.buffer.slice(offset);
    }
    return chunks;
  }

  /**
   * Return the remaining buffered samples when they amount to at least one
   * second of audio (used for the final partial chunk on stop), else null.
   */
  flush(): Float32Array | null {
    if (this.buffer.length >= this.minFlushSamples) {
      const out = this.buffer;
      this.buffer = new Float32Array(0);
      return out;
    }
    return null;
  }

  /** Clear any buffered (incomplete) samples. */
  reset(): void {
    this.buffer = new Float32Array(0);
  }
}

// ---------------------------------------------------------------------------
// Minimal structural interfaces for the Web Audio / MediaStream surface the
// session touches. The real DOM types satisfy these structurally, and tests
// can substitute fakes without a DOM.
// ---------------------------------------------------------------------------

export interface LiveMediaStreamTrackLike {
  enabled: boolean;
  stop(): void;
  onended: ((...args: unknown[]) => void) | null;
}

export interface LiveMediaStreamLike {
  getTracks(): LiveMediaStreamTrackLike[];
  getAudioTracks(): LiveMediaStreamTrackLike[];
  getVideoTracks(): LiveMediaStreamTrackLike[];
}

export interface LiveAudioNodeLike {
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface LiveAudioProcessEvent {
  inputBuffer: {
    getChannelData(channel: number): Float32Array;
  };
}

export interface LiveScriptProcessorLike extends LiveAudioNodeLike {
  onaudioprocess: ((event: LiveAudioProcessEvent) => void) | null;
}

export interface LiveAudioContextLike {
  createMediaStreamSource(stream: LiveMediaStreamLike): LiveAudioNodeLike;
  createScriptProcessor(
    bufferSize: number,
    numInputChannels: number,
    numOutputChannels: number,
  ): LiveScriptProcessorLike;
  readonly destination: unknown;
  close(): Promise<void>;
}

/** Injected factories so the session never touches `navigator` directly. */
export interface LiveCaptureDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<LiveMediaStreamLike>;
  getDisplayMedia(constraints: MediaStreamConstraints): Promise<LiveMediaStreamLike>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  createAudioContext(sampleRate: number): LiveAudioContextLike;
}

export interface LiveRecordingSessionOptions {
  /** Seconds of audio per transcription chunk (default 15). */
  chunkSeconds?: number;
  /** Seconds of overlap between chunks (default 0.5). */
  overlapSeconds?: number;
  sampleRate?: number;
  /** Called with each full chunk of 16 kHz mono PCM, in arrival order. */
  onChunk: (pcm: Float32Array) => void;
  /** Called for unexpected in-session errors (e.g. the track ended). */
  onError: (error: Error) => void;
  /** Injectable clock (ms) for testability; defaults to Date.now. */
  clock?: () => number;
}

/**
 * One live recording session: owns the MediaStream, the 16 kHz AudioContext
 * graph, and the chunker. `pause()` suspends capture (frames are dropped and
 * the tracks are disabled) without ending the session; `stop()` tears the
 * graph down and returns the final partial chunk if it is at least one
 * second long.
 */
export class LiveRecordingSession {
  private readonly deps: LiveCaptureDeps;
  private readonly chunkSeconds: number;
  private readonly overlapSeconds: number;
  private readonly sampleRate: number;
  private readonly onChunk: (pcm: Float32Array) => void;
  private readonly onError: (error: Error) => void;
  private readonly clock: () => number;

  private chunker: LiveChunker;
  private stream: LiveMediaStreamLike | null = null;
  private context: LiveAudioContextLike | null = null;
  private sourceNode: LiveAudioNodeLike | null = null;
  private processor: LiveScriptProcessorLike | null = null;
  private recording = false;
  private paused = false;
  private startedAtMs = 0;
  private pausedAtMs = 0;
  private pausedTotalMs = 0;

  constructor(deps: LiveCaptureDeps, opts: LiveRecordingSessionOptions) {
    this.deps = deps;
    this.chunkSeconds = opts.chunkSeconds ?? 15;
    this.overlapSeconds = opts.overlapSeconds ?? 0.5;
    this.sampleRate = opts.sampleRate ?? LIVE_SAMPLE_RATE;
    this.onChunk = opts.onChunk;
    this.onError = opts.onError;
    this.clock = opts.clock ?? (() => Date.now());
    this.chunker = new LiveChunker({
      sampleRate: this.sampleRate,
      chunkSeconds: this.chunkSeconds,
      overlapSeconds: this.overlapSeconds,
    });
  }

  isRecording(): boolean {
    return this.recording;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Acquire the audio stream and start the capture graph.
   *
   * - `"microphone"`: `getUserMedia` (optionally pinned to `deviceId`).
   * - `"system"`: if a specific input device is selected (a loopback device
   *   such as BlackHole / Stereo Mix / a PulseAudio monitor), capture it via
   *   `getUserMedia`. Otherwise attempt `getDisplayMedia({ video, audio })`
   *   and use its audio track when the platform provides one; when it does
   *   not, throw a descriptive error so the caller can direct the user to a
   *   loopback device. The microphone is never used as a silent fallback.
   */
  async start(source: LiveAudioSource, deviceId?: string): Promise<void> {
    if (this.recording) {
      throw new Error("A live recording session is already active.");
    }

    let stream: LiveMediaStreamLike;
    if (source === "system" && deviceId) {
      // A loopback input device is an ordinary audioinput on the OS.
      stream = await this.deps.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });
    } else if (source === "system") {
      let displayStream: LiveMediaStreamLike | null = null;
      try {
        displayStream = await this.deps.getDisplayMedia({
          video: true,
          audio: true,
        });
      } catch {
        displayStream = null; // user declined the share prompt
      }
      if (
        displayStream === null ||
        displayStream.getAudioTracks().length === 0
      ) {
        for (const track of displayStream?.getTracks() ?? []) track.stop();
        throw new Error(
          `${SYSTEM_AUDIO_UNAVAILABLE}: screen sharing did not provide an ` +
            `audio track. Select a loopback input device in the "Input device" ` +
            `dropdown instead (e.g. BlackHole on macOS, Stereo Mix or VB-CABLE ` +
            `on Windows, a PulseAudio/PipeWire monitor source on Linux). The ` +
            `microphone is not used as a fallback.`,
        );
      }
      // Keep only the audio track; we do not use the shared video.
      for (const track of displayStream.getVideoTracks()) track.stop();
      stream = displayStream;
    } else {
      stream = await this.deps.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      });
    }

    const context = this.deps.createAudioContext(this.sampleRate);
    const sourceNode = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      this.handleFrame(event.inputBuffer.getChannelData(0));
    };
    sourceNode.connect(processor);
    // The processor must be connected to the destination for
    // onaudioprocess to fire in Chromium.
    processor.connect(context.destination);

    // If the OS revokes the stream mid-session (e.g. device unplugged),
    // surface it and tear down.
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (!this.recording) return;
        this.onError(new Error("The audio input ended unexpectedly."));
      };
    }

    this.chunker = new LiveChunker({
      sampleRate: this.sampleRate,
      chunkSeconds: this.chunkSeconds,
      overlapSeconds: this.overlapSeconds,
    });
    this.stream = stream;
    this.context = context;
    this.sourceNode = sourceNode;
    this.processor = processor;
    this.recording = true;
    this.paused = false;
    this.startedAtMs = this.clock();
    this.pausedAtMs = 0;
    this.pausedTotalMs = 0;
  }

  /**
   * Suspend capture: incoming frames are dropped and the tracks are
   * disabled (so the OS recording indicator reflects the pause). Samples
   * already buffered in the chunker are kept; chunking continues on resume.
   */
  pause(): void {
    if (!this.recording || this.paused) return;
    this.paused = true;
    this.pausedAtMs = this.clock();
    for (const track of this.stream?.getTracks() ?? []) {
      track.enabled = false;
    }
  }

  /** Resume a paused session. */
  resume(): void {
    if (!this.recording || !this.paused) return;
    this.pausedTotalMs += this.clock() - this.pausedAtMs;
    this.paused = false;
    for (const track of this.stream?.getTracks() ?? []) {
      track.enabled = true;
    }
  }

  /**
   * End the session: tear down the graph, stop the tracks, close the
   * context, and return the final partial chunk (when it is at least one
   * second of audio) so the caller can transcribe it.
   */
  async stop(): Promise<Float32Array | null> {
    if (!this.recording) return null;
    this.recording = false;
    if (this.paused) {
      this.pausedTotalMs += this.clock() - this.pausedAtMs;
      this.paused = false;
    }

    const tail = this.chunker.flush();

    const processor = this.processor;
    this.processor = null;
    this.sourceNode = null;
    if (processor) {
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        // already disconnected
      }
    }
    const stream = this.stream;
    this.stream = null;
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    const context = this.context;
    this.context = null;
    if (context) {
      try {
        await context.close();
      } catch {
        // already closed
      }
    }
    return tail;
  }

  /** Accumulated unpaused capture time in seconds (for the UI timer). */
  elapsedSeconds(): number {
    if (!this.recording) return 0;
    const now = this.paused ? this.pausedAtMs : this.clock();
    return Math.max(0, (now - this.startedAtMs - this.pausedTotalMs) / 1000);
  }

  private handleFrame(samples: Float32Array): void {
    if (!this.recording || this.paused) return;
    for (const chunk of this.chunker.push(samples)) {
      this.onChunk(chunk);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin-wide single-session coordination
// ---------------------------------------------------------------------------

/**
 * Anything that can report whether its live capture is currently running
 * (the recording modal satisfies this structurally).
 */
export interface LiveSessionOwner {
  isRecording(): boolean;
}

/**
 * Tracks the single live recording session allowed across the whole plugin.
 * Framework-free so the coordination rule stays unit-testable: at most one
 * owner may hold the slot at a time, including while capture is starting;
 * `release` only clears the slot if the releasing owner still holds it.
 */
export class LiveSessionRegistry {
  private active: LiveSessionOwner | null = null;

  /** True when the current owner has started recording. */
  isRecording(): boolean {
    return this.active !== null && this.active.isRecording();
  }

  /**
   * Claim the single active slot. Returns false (without claiming) when
   * another owner already holds it; the caller must refuse with a Notice.
   */
  tryClaim(owner: LiveSessionOwner): boolean {
    if (this.active !== null && this.active !== owner) return false;
    this.active = owner;
    return true;
  }

  /** Release the slot, but only if `owner` still holds it. */
  release(owner: LiveSessionOwner): void {
    if (this.active === owner) this.active = null;
  }
}

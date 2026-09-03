import { createWriteStream, promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";

/** Size of the canonical RIFF/WAVE header written by `wavHeader`. */
export const WAV_HEADER_BYTES = 44;

/** Largest value a 32-bit RIFF size field can hold. */
const MAX_RIFF_SIZE = 0xffffffff;

/** Byte offset of the RIFF chunk size and the data chunk size fields. */
const RIFF_SIZE_OFFSET = 4;
const DATA_SIZE_OFFSET = 40;

/**
 * Build the canonical 44-byte RIFF/WAVE header for `dataBytes` of PCM.
 *
 * Only plain PCM (audio format 1) is emitted: it is the one layout every
 * decoder understands, and it is all the plugin ever writes. The size
 * fields saturate at 2^32-1 instead of throwing because the header is also
 * written while the data size is still unknown, and a recording that
 * outgrows the format (~37 hours of 16 kHz mono) should still end up as a
 * file the tolerant decoder below can read rather than an exception in the
 * close path.
 */
export function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(Math.min(36 + dataBytes, MAX_RIFF_SIZE), RIFF_SIZE_OFFSET);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt payload size for plain PCM
  header.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(Math.min(dataBytes, MAX_RIFF_SIZE), DATA_SIZE_OFFSET);
  return header;
}

/**
 * Convert float samples in [-1, 1] to 16-bit little-endian PCM.
 *
 * The two scale factors are asymmetric on purpose: int16 spans
 * -32768..32767, so -1 must map to -32768 and +1 to 32767 for both rails to
 * be reachable without overflow. Out-of-range input is clamped rather than
 * wrapped, since a Web Audio graph can legitimately overshoot 1.0 and
 * wrapping would turn a slightly hot signal into a full-scale click. Always
 * allocates a fresh Buffer so the caller's Float32Array (possibly a
 * transferred AudioWorklet buffer) is never aliased.
 */
export function encodePcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    else if (Number.isNaN(s)) s = 0;
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return out;
}

/**
 * Interleave per-channel lanes into one frame-major Float32Array
 * (`lanes[0][i], lanes[1][i], ...`). A shorter lane is padded with silence
 * to the longest length because the two sides of a call can stop delivering
 * frames at slightly different moments and a WAV frame must carry every
 * channel. A single lane comes back as a copy so callers get the same
 * "fresh buffer" guarantee regardless of channel count.
 */
export function interleave(lanes: Float32Array[]): Float32Array {
  if (lanes.length === 1) return lanes[0].slice();
  const count = lanes.length;
  let longest = 0;
  for (const lane of lanes) if (lane.length > longest) longest = lane.length;
  // Float32Array is zero-initialised, which is exactly the padding we want.
  const out = new Float32Array(longest * count);
  for (let c = 0; c < count; c++) {
    const lane = lanes[c];
    for (let i = 0; i < lane.length; i++) out[i * count + c] = lane[i];
  }
  return out;
}

/** Read a four-character chunk id at `offset`. */
function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** What the RIFF chunk walk found about a 16-bit PCM file. */
export interface WavPcm16Header {
  channels: number;
  sampleRate: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  /** Usable PCM bytes: the declared size, or what is present when it lies. */
  dataBytes: number;
}

/**
 * Walk the RIFF chunks in the first `length` bytes of `view` and describe
 * the PCM data. `totalLength` is the file's real size, which decides how
 * many bytes are usable when the data size field is 0, 0xFFFFFFFF or larger
 * than the file. Returns null unless the file is plain 16-bit PCM and both
 * the `fmt ` chunk and the `data` chunk header lie within `length`.
 */
export function parseWavPcm16Header(
  view: DataView,
  length: number,
  totalLength: number,
): WavPcm16Header | null {
  if (length < 12) return null;
  if (fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") return null;

  let fmt: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let data: { offset: number; size: number } | null = null;

  let pos = 12;
  while (pos + 8 <= length) {
    const id = fourcc(view, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > length) return null;
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      const available = Math.max(0, totalLength - body);
      const lying = size === 0 || size > available;
      data = { offset: body, size: lying ? available : size };
      // A lying size means the file ends in this chunk: nothing follows.
      if (lying) break;
    }
    // Word alignment: skip the pad byte after an odd-sized body.
    pos = body + size + (size & 1);
  }

  if (!fmt || !data) return null;
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null;
  if (fmt.channels < 1 || fmt.sampleRate < 1) return null;
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    dataOffset: data.offset,
    dataBytes: data.size,
  };
}

export interface ReadWavOptions {
  /** Bytes read per step (default 1 MiB); tests use small values. */
  blockBytes?: number;
  /** Bytes scanned for the chunk headers (default 64 KiB). */
  headerBytes?: number;
}

/**
 * Read one channel (or the average of all channels, `"mix"`) of a 16-bit
 * PCM WAV file straight from disk into a Float32Array, block by block. An
 * hour of the plugin's own stereo recording is 230 MB on disk; loading it
 * whole and decoding every channel would take roughly four times that in
 * the renderer for a pass that only needs one channel. Returns null when
 * the file is not plain 16-bit PCM or its header is not found in the first
 * `headerBytes`.
 */
export async function readWavPcm16Channel(
  absPath: string,
  channel: number | "mix",
  opts: ReadWavOptions = {},
): Promise<{ samples: Float32Array; sampleRate: number; channels: number } | null> {
  const handle = await fsp.open(absPath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const headerBytes = Math.min(fileSize, opts.headerBytes ?? 65536);
    const head = Buffer.alloc(headerBytes);
    await handle.read(head, 0, headerBytes, 0);
    const info = parseWavPcm16Header(
      new DataView(head.buffer, head.byteOffset, headerBytes),
      headerBytes,
      fileSize,
    );
    if (!info) return null;
    if (channel !== "mix" && (channel < 0 || channel >= info.channels)) {
      throw new RangeError(
        `readWavPcm16Channel: channel ${channel} of ${info.channels}`,
      );
    }

    const frameBytes = info.channels * 2;
    const frames = Math.floor(info.dataBytes / frameBytes);
    const samples = new Float32Array(frames);
    const blockFrames = Math.max(
      1,
      Math.floor((opts.blockBytes ?? 1 << 20) / frameBytes),
    );
    const block = Buffer.alloc(blockFrames * frameBytes);
    const scale = 1 / (32768 * (channel === "mix" ? info.channels : 1));
    let frame = 0;
    let filePos = info.dataOffset;
    while (frame < frames) {
      const want = Math.min(blockFrames, frames - frame);
      const { bytesRead } = await handle.read(block, 0, want * frameBytes, filePos);
      const got = Math.floor(bytesRead / frameBytes);
      if (got === 0) break;
      for (let i = 0; i < got; i++) {
        const base = i * frameBytes;
        if (channel === "mix") {
          let sum = 0;
          for (let c = 0; c < info.channels; c++) {
            sum += block.readInt16LE(base + 2 * c);
          }
          samples[frame + i] = sum * scale;
        } else {
          samples[frame + i] = block.readInt16LE(base + 2 * channel) * scale;
        }
      }
      frame += got;
      filePos += got * frameBytes;
    }
    return {
      samples: frame === frames ? samples : samples.subarray(0, frame),
      sampleRate: info.sampleRate,
      channels: info.channels,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Decode a 16-bit PCM WAV file into per-channel float samples.
 *
 * This is a pure RIFF chunk walk rather than a fixed 44-byte parse so that
 * files with extra chunks (LIST/INFO, fact, ...) in any order still decode;
 * chunks are word-aligned, so an odd-sized body is followed by a pad byte
 * that the size field does not count. Returns null for anything that is
 * not plain 16-bit PCM (8-bit, float, extensible, compressed) so the caller
 * can fall back to Web Audio decoding, which understands far more formats.
 *
 * A data size of 0, 0xFFFFFFFF or beyond the end of the file is treated as
 * "unknown" and the bytes actually present are used: that is what the
 * plugin's own writer leaves behind if the process dies before `close()`
 * patches the header, and those recordings are the ones worth rescuing.
 */
export function decodeWavPcm16(
  bytes: ArrayBuffer,
): { channels: Float32Array[]; sampleRate: number } | null {
  const view = new DataView(bytes);
  const length = bytes.byteLength;
  const info = parseWavPcm16Header(view, length, length);
  if (!info) return null;
  const fmt = info;
  const data = { offset: info.dataOffset, size: info.dataBytes };

  const frameBytes = fmt.channels * 2;
  const frames = Math.floor(data.size / frameBytes);
  const channels: Float32Array[] = [];
  for (let c = 0; c < fmt.channels; c++) channels.push(new Float32Array(frames));
  let p = data.offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      channels[c][i] = view.getInt16(p, true) / 32768;
      p += 2;
    }
  }
  return { channels, sampleRate: fmt.sampleRate };
}

/** The slice of a Node writable the writer relies on. */
type WavStream = NodeJS.WritableStream & { destroy(err?: Error): void };

export interface WavWriterDeps {
  /** Replaces `fs.createWriteStream`; lets tests inject a failing sink. */
  createStream?: (path: string) => WavStream;
}

export interface WavCloseResult {
  dataBytes: number;
  seconds: number;
}

const NO_SAMPLES = new Float32Array(0);

/**
 * Wait for an fs write stream to actually open its descriptor so that
 * `open()` rejects on EISDIR/EACCES instead of surfacing the failure on the
 * first frame. Injected streams (tests) have no `pending` flag and are
 * treated as already open.
 */
function waitForOpen(stream: WavStream): Promise<void> {
  if (!("pending" in stream) || stream.pending !== true) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off("open", onOpen);
      stream.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

/**
 * Streams 16-bit PCM to a WAV file on disk as audio frames arrive.
 *
 * The header is written up front with a zero data size and patched in
 * `close()`, because the length is unknown until the recording stops and a
 * WAV must be written front to back. Frames are handed to the fs stream
 * without awaiting: `write()` runs inside an audio-frame callback and at
 * 32 KB/s per channel the stream's own buffering is ample backpressure. A
 * stream error is captured in `failed` rather than thrown from `write()`
 * so a full disk cannot crash the capture loop; `close()` reports it.
 */
export class WavFileWriter {
  readonly path: string;
  readonly sampleRate: number;
  readonly channels: number;
  private readonly stream: WavStream;
  private bytes = 0;
  private error: Error | null = null;
  private ended = false;
  private aborted = false;
  private closing: Promise<WavCloseResult> | null = null;

  private constructor(
    absPath: string,
    sampleRate: number,
    channels: number,
    stream: WavStream,
  ) {
    this.path = absPath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.stream = stream;
    // An 'error' event with no listener is an uncaught exception that would
    // take down the renderer mid-meeting; record it and let close() report.
    stream.on("error", (e: Error) => {
      if (!this.error) this.error = e;
    });
  }

  /**
   * Create the parent directory, open the file and write the placeholder
   * header. Rejects if the file cannot be created (parent is a regular
   * file, path is a directory, permissions, ...).
   */
  static async open(
    absPath: string,
    sampleRate = 16000,
    channels = 1,
    deps?: WavWriterDeps,
  ): Promise<WavFileWriter> {
    await fsp.mkdir(dirname(absPath), { recursive: true });
    // Exclusive create, owner-only: the file must not exist yet (so a
    // symlink planted in a shared temp directory cannot redirect the write)
    // and nobody else on the machine can read the recording.
    const create =
      deps?.createStream ??
      ((p: string) => createWriteStream(p, { flags: "wx", mode: 0o600 }));
    const stream = create(absPath);
    const writer = new WavFileWriter(absPath, sampleRate, channels, stream);
    try {
      await waitForOpen(stream);
    } catch (e) {
      stream.destroy();
      throw e;
    }
    stream.write(wavHeader(0, sampleRate, channels));
    return writer;
  }

  /** The stream error, if any; once set, `write()` is a no-op. */
  get failed(): Error | null {
    return this.error;
  }

  /** PCM bytes handed to the stream so far (excluding the header). */
  get dataBytes(): number {
    return this.bytes;
  }

  /**
   * Queue one frame per channel. `lanes.length` must not exceed
   * `channels`; a missing lane is silence, so a one-sided recording of a
   * two-channel session still produces a valid stereo file.
   */
  write(lanes: Float32Array[]): void {
    if (lanes.length > this.channels) {
      throw new RangeError(
        `WavFileWriter: got ${lanes.length} lanes for ${this.channels} channel(s)`,
      );
    }
    if (this.error || this.ended) return;
    let pcm: Buffer;
    if (this.channels === 1) {
      pcm = encodePcm16(lanes[0] ?? NO_SAMPLES);
    } else {
      const full = lanes.slice();
      while (full.length < this.channels) full.push(NO_SAMPLES);
      pcm = encodePcm16(interleave(full));
    }
    if (pcm.length === 0) return;
    this.bytes += pcm.length;
    this.stream.write(pcm);
  }

  /**
   * Flush the stream and patch the header sizes. Throws the captured stream
   * error (after removing the unusable file) if any write failed. Calling
   * it again returns the same result.
   */
  close(): Promise<WavCloseResult> {
    if (!this.closing) this.closing = this.finish();
    return this.closing;
  }

  private async finish(): Promise<WavCloseResult> {
    if (this.aborted) {
      throw new Error(`WavFileWriter: ${this.path} was aborted`);
    }
    this.ended = true;
    if (this.error) this.stream.destroy();
    else this.stream.end();
    // Resolves once the data is flushed and the descriptor closed (fs
    // streams auto-destroy), so the r+ reopen below never races the close.
    await finished(this.stream).catch((e: Error) => {
      if (!this.error) this.error = e;
    });
    if (this.error) {
      // fs streams destroy themselves on error; an injected one might not.
      this.stream.destroy();
      await finished(this.stream).catch(() => undefined);
      await fsp.rm(this.path, { force: true });
      throw this.error;
    }
    await this.patchSizes();
    return {
      dataBytes: this.bytes,
      seconds: this.bytes / (this.sampleRate * this.channels * 2),
    };
  }

  /**
   * Rewrite only the two size fields. Taking them from a freshly built
   * header keeps the field layout (and the saturation rule) in one place.
   */
  private async patchSizes(): Promise<void> {
    const header = wavHeader(this.bytes, this.sampleRate, this.channels);
    const fh = await fsp.open(this.path, "r+");
    try {
      await fh.write(header, RIFF_SIZE_OFFSET, 4, RIFF_SIZE_OFFSET);
      await fh.write(header, DATA_SIZE_OFFSET, 4, DATA_SIZE_OFFSET);
    } finally {
      await fh.close();
    }
  }

  /**
   * Discard the recording: destroy the stream and remove the file. Safe to
   * call repeatedly; after a successful `close()` it deletes the finished
   * file, so callers that want to keep the recording must not call it.
   */
  async abort(): Promise<void> {
    this.ended = true;
    this.aborted = true;
    this.stream.destroy();
    await finished(this.stream).catch(() => undefined);
    await fsp.rm(this.path, { force: true });
  }
}

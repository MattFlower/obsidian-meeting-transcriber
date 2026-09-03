import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import {
  WAV_HEADER_BYTES,
  WavFileWriter,
  decodeWavPcm16,
  encodePcm16,
  interleave,
  wavHeader,
  readWavPcm16Channel,
} from "../src/wav";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Copy a Buffer into a standalone ArrayBuffer (Buffers may share a pool). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** A RIFF chunk with the pad byte an odd-sized body requires. */
function chunk(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, body, pad]);
}

function fmtBody(
  format: number,
  channels: number,
  sampleRate: number,
  bits: number,
): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(format, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(sampleRate, 4);
  b.writeUInt32LE((sampleRate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}

/** A deterministic sawtooth in [-scale, scale). */
function ramp(n: number, scale = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((i % 200) / 100 - 1) * scale;
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Round-trip tolerance. Encoding rounds to the nearest int16 (half an LSB)
 * and positive samples are scaled by 32767 but decoded by 32768 (up to one
 * more LSB near full scale), so 1.5/32768 is the exact bound.
 */
const TOLERANCE = 1.5 / 32768 + 1e-9;

function expectClose(actual: Float32Array, expected: Float32Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (diff > TOLERANCE) {
      throw new Error(
        `sample ${i}: got ${actual[i]}, expected ${expected[i]} (diff ${diff})`,
      );
    }
  }
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "wav-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A writable that fails the Nth write with `message`. */
function failingStream(failOnWrite: number, message: string): Writable {
  let writes = 0;
  return new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback(writes === failOnWrite ? new Error(message) : null);
    },
  });
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// wavHeader
// ---------------------------------------------------------------------------

describe("wavHeader", () => {
  it("lays out every field of a mono 16 kHz header", () => {
    const h = wavHeader(8000, 16000);
    expect(WAV_HEADER_BYTES).toBe(44);
    expect(h.length).toBe(44);
    expect(h.toString("ascii", 0, 4)).toBe("RIFF");
    expect(h.readUInt32LE(4)).toBe(36 + 8000);
    expect(h.toString("ascii", 8, 12)).toBe("WAVE");
    expect(h.toString("ascii", 12, 16)).toBe("fmt ");
    expect(h.readUInt32LE(16)).toBe(16);
    expect(h.readUInt16LE(20)).toBe(1);
    expect(h.readUInt16LE(22)).toBe(1);
    expect(h.readUInt32LE(24)).toBe(16000);
    expect(h.readUInt32LE(28)).toBe(32000);
    expect(h.readUInt16LE(32)).toBe(2);
    expect(h.readUInt16LE(34)).toBe(16);
    expect(h.toString("ascii", 36, 40)).toBe("data");
    expect(h.readUInt32LE(40)).toBe(8000);
  });

  it("derives byte rate and block align for stereo", () => {
    const h = wavHeader(0, 44100, 2);
    expect(h.readUInt16LE(22)).toBe(2);
    expect(h.readUInt32LE(24)).toBe(44100);
    expect(h.readUInt32LE(28)).toBe(44100 * 4);
    expect(h.readUInt16LE(32)).toBe(4);
    expect(h.readUInt16LE(34)).toBe(16);
    expect(h.readUInt32LE(4)).toBe(36);
    expect(h.readUInt32LE(40)).toBe(0);
  });

  it("saturates the size fields instead of throwing past 4 GB", () => {
    const h = wavHeader(0x1_0000_0000, 16000);
    expect(h.readUInt32LE(4)).toBe(0xffffffff);
    expect(h.readUInt32LE(40)).toBe(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// encodePcm16
// ---------------------------------------------------------------------------

describe("encodePcm16", () => {
  it("scales the negative rail by 32768 and the positive rail by 32767", () => {
    const pcm = encodePcm16(new Float32Array([-1, 1, 0, -0.5, 0.5]));
    expect(pcm.length).toBe(10);
    expect(pcm.readInt16LE(0)).toBe(-32768);
    expect(pcm.readInt16LE(2)).toBe(32767);
    expect(pcm.readInt16LE(4)).toBe(0);
    expect(pcm.readInt16LE(6)).toBe(-16384);
    expect(pcm.readInt16LE(8)).toBe(16384); // 16383.5 rounds up
  });

  it("clamps values outside [-1, 1] and treats NaN as silence", () => {
    const pcm = encodePcm16(new Float32Array([2, -3, 1.0001, NaN]));
    expect(pcm.readInt16LE(0)).toBe(32767);
    expect(pcm.readInt16LE(2)).toBe(-32768);
    expect(pcm.readInt16LE(4)).toBe(32767);
    expect(pcm.readInt16LE(6)).toBe(0);
  });

  it("rounds to the nearest integer and writes little-endian", () => {
    const pcm = encodePcm16(new Float32Array([1 / 32767, 0.3 / 32767]));
    expect([...pcm]).toEqual([1, 0, 0, 0]);
    expect(encodePcm16(new Float32Array(0)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// interleave
// ---------------------------------------------------------------------------

describe("interleave", () => {
  it("alternates lanes and zero-pads the shorter one", () => {
    const out = interleave([
      new Float32Array([1, 2, 3]),
      new Float32Array([-1, -2]),
    ]);
    expect([...out]).toEqual([1, -1, 2, -2, 3, 0]);
  });

  it("returns a copy for a single lane", () => {
    const lane = new Float32Array([0.25, 0.5]);
    const out = interleave([lane]);
    expect([...out]).toEqual([0.25, 0.5]);
    out[0] = 9;
    expect(lane[0]).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// decodeWavPcm16
// ---------------------------------------------------------------------------

describe("decodeWavPcm16", () => {
  const samples = ramp(300, 0.8);
  const pcm = encodePcm16(samples);

  it("returns null for garbage and for incomplete RIFF structures", () => {
    expect(decodeWavPcm16(new ArrayBuffer(0))).toBeNull();
    expect(
      decodeWavPcm16(toArrayBuffer(Buffer.from("definitely not a wav file"))),
    ).toBeNull();
    const notWave = riff([chunk("fmt ", fmtBody(1, 1, 16000, 16)), chunk("data", pcm)]);
    notWave.write("AVI ", 8, "ascii");
    expect(decodeWavPcm16(toArrayBuffer(notWave))).toBeNull();
    // fmt without data, and data without fmt.
    expect(
      decodeWavPcm16(toArrayBuffer(riff([chunk("fmt ", fmtBody(1, 1, 16000, 16))]))),
    ).toBeNull();
    expect(decodeWavPcm16(toArrayBuffer(riff([chunk("data", pcm)])))).toBeNull();
  });

  it("returns null for 8-bit and float formats", () => {
    const eightBit = riff([chunk("fmt ", fmtBody(1, 1, 8000, 8)), chunk("data", pcm)]);
    expect(decodeWavPcm16(toArrayBuffer(eightBit))).toBeNull();
    const float = riff([chunk("fmt ", fmtBody(3, 1, 16000, 32)), chunk("data", pcm)]);
    expect(decodeWavPcm16(toArrayBuffer(float))).toBeNull();
  });

  it("decodes plain mono PCM", () => {
    const wav = riff([chunk("fmt ", fmtBody(1, 1, 16000, 16)), chunk("data", pcm)]);
    const decoded = decodeWavPcm16(toArrayBuffer(wav));
    expect(decoded).not.toBeNull();
    expect(decoded!.sampleRate).toBe(16000);
    expect(decoded!.channels).toHaveLength(1);
    expectClose(decoded!.channels[0], samples);
  });

  it("skips the pad byte of an odd-sized chunk before data", () => {
    const wav = riff([
      chunk("fmt ", fmtBody(1, 1, 22050, 16)),
      chunk("LIST", Buffer.from("abc")),
      chunk("data", pcm),
      chunk("LIST", Buffer.from("trailing")),
    ]);
    const decoded = decodeWavPcm16(toArrayBuffer(wav));
    expect(decoded!.sampleRate).toBe(22050);
    expectClose(decoded!.channels[0], samples);
  });

  it("accepts chunks in any order and de-interleaves stereo", () => {
    const left = ramp(120, 0.6);
    const right = ramp(120, 0.2);
    const wav = riff([
      chunk("data", encodePcm16(interleave([left, right]))),
      chunk("fmt ", fmtBody(1, 2, 48000, 16)),
    ]);
    const decoded = decodeWavPcm16(toArrayBuffer(wav));
    expect(decoded!.sampleRate).toBe(48000);
    expect(decoded!.channels).toHaveLength(2);
    expectClose(decoded!.channels[0], left);
    expectClose(decoded!.channels[1], right);
  });

  it("uses the bytes present when the data size is 0xFFFFFFFF or 0 (unpatched header)", () => {
    const unpatched = Buffer.concat([wavHeader(0, 16000), pcm]);
    const decodedZero = decodeWavPcm16(toArrayBuffer(unpatched));
    expectClose(decodedZero!.channels[0], samples);

    const maxed = Buffer.from(unpatched);
    maxed.writeUInt32LE(0xffffffff, 4);
    maxed.writeUInt32LE(0xffffffff, 40);
    const decodedMax = decodeWavPcm16(toArrayBuffer(maxed));
    expectClose(decodedMax!.channels[0], samples);
  });

  it("uses the bytes present when the data size exceeds the file and drops a partial frame", () => {
    const truncated = Buffer.concat([
      wavHeader(999_999, 16000),
      pcm,
      Buffer.from([0x7f]), // half a sample from an interrupted write
    ]);
    const decoded = decodeWavPcm16(toArrayBuffer(truncated));
    expectClose(decoded!.channels[0], samples);
  });
});

// ---------------------------------------------------------------------------
// WavFileWriter
// ---------------------------------------------------------------------------

describe("WavFileWriter", () => {
  it("writes a mono file whose header is patched on close and round-trips the samples", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "nested", "deeper", "rec.wav");
      const w = await WavFileWriter.open(file);
      expect(w.path).toBe(file);
      expect(w.sampleRate).toBe(16000);
      expect(w.channels).toBe(1);
      expect(w.failed).toBeNull();

      const frames = [ramp(1600), ramp(1600, 0.5), ramp(800, 0.25)];
      for (const f of frames) w.write([f]);
      expect(w.dataBytes).toBe(4000 * 2);

      const result = await w.close();
      expect(result).toEqual({ dataBytes: 8000, seconds: 0.25 });
      // A second close() is harmless and reports the same thing.
      await expect(w.close()).resolves.toEqual(result);

      const bytes = await readFile(file);
      expect(bytes.length).toBe(WAV_HEADER_BYTES + 8000);
      expect(bytes.readUInt32LE(4)).toBe(36 + 8000);
      expect(bytes.readUInt32LE(40)).toBe(8000);
      expect(bytes.subarray(0, 44).equals(wavHeader(8000, 16000, 1))).toBe(true);

      const decoded = decodeWavPcm16(toArrayBuffer(bytes));
      expect(decoded!.sampleRate).toBe(16000);
      expect(decoded!.channels).toHaveLength(1);
      expectClose(decoded!.channels[0], concat(frames));
    });
  });

  it("interleaves two lanes into a stereo file, padding the shorter lane with silence", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "stereo.wav");
      const w = await WavFileWriter.open(file, 44100, 2);
      const left = ramp(1000, 0.9);
      const right = ramp(600, 0.3);
      w.write([left, right]);
      const left2 = ramp(100, 0.1);
      const right2 = ramp(100, 0.2);
      w.write([left2, right2]);

      const result = await w.close();
      expect(result.dataBytes).toBe(1100 * 4);
      expect(result.seconds).toBeCloseTo(1100 / 44100, 9);

      const bytes = await readFile(file);
      expect(bytes.length).toBe(WAV_HEADER_BYTES + 4400);
      expect(bytes.readUInt16LE(22)).toBe(2);
      expect(bytes.readUInt32LE(40)).toBe(4400);

      const decoded = decodeWavPcm16(toArrayBuffer(bytes));
      expect(decoded!.sampleRate).toBe(44100);
      expect(decoded!.channels).toHaveLength(2);
      expectClose(decoded!.channels[0], concat([left, left2]));
      expectClose(
        decoded!.channels[1],
        concat([right, new Float32Array(400), right2]),
      );
    });
  });

  it("treats a missing lane as silence and rejects too many lanes", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "one-sided.wav");
      const w = await WavFileWriter.open(file, 16000, 2);
      const mic = ramp(320, 0.7);
      w.write([mic]);
      expect(() => w.write([mic, mic, mic])).toThrow(RangeError);
      await w.close();

      const decoded = decodeWavPcm16(toArrayBuffer(await readFile(file)));
      expect(decoded!.channels).toHaveLength(2);
      expectClose(decoded!.channels[0], mic);
      expect(decoded!.channels[1].every((s) => s === 0)).toBe(true);
      expect(decoded!.channels[1]).toHaveLength(320);
    });
  });

  it("copies the samples at write time so the caller may reuse its buffer", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "copy.wav");
      const w = await WavFileWriter.open(file);
      const frame = ramp(320, 0.5);
      const original = frame.slice();
      w.write([frame]);
      frame.fill(0.75);
      await w.close();
      const decoded = decodeWavPcm16(toArrayBuffer(await readFile(file)));
      expectClose(decoded!.channels[0], original);
    });
  });

  it("abort() removes the file, is idempotent, and makes later writes no-ops", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "sub", "aborted.wav");
      const w = await WavFileWriter.open(file);
      w.write([ramp(160)]);
      await expect(stat(file)).resolves.toBeTruthy();

      await w.abort();
      await expect(stat(file)).rejects.toThrow(/ENOENT/);
      await w.abort();
      await expect(stat(file)).rejects.toThrow(/ENOENT/);

      w.write([ramp(160)]);
      expect(w.dataBytes).toBe(320);
      await expect(w.close()).rejects.toThrow(/abort/);
    });
  });

  it("abort() after close() is safe and discards the finished file", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "done.wav");
      const w = await WavFileWriter.open(file);
      w.write([ramp(160)]);
      await w.close();
      await expect(stat(file)).resolves.toBeTruthy();
      await w.abort();
      await expect(stat(file)).rejects.toThrow(/ENOENT/);
    });
  });

  it("captures a stream error: write() becomes a no-op and close() throws it", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "bad.wav");
      // Write #1 is the placeholder header; the first frame (#2) fails.
      const stream = failingStream(2, "disk full");
      const w = await WavFileWriter.open(file, 16000, 1, {
        createStream: () => stream,
      });
      expect(w.failed).toBeNull();

      w.write([ramp(160)]);
      expect(w.dataBytes).toBe(320);
      await tick();
      expect(w.failed).toBeInstanceOf(Error);
      expect(w.failed!.message).toBe("disk full");

      w.write([ramp(160)]);
      expect(w.dataBytes).toBe(320);

      await expect(w.close()).rejects.toThrow("disk full");
      await expect(stat(file)).rejects.toThrow(/ENOENT/);
    });
  });

  it("open() rejects when the parent path is a regular file", async () => {
    await withDir(async (dir) => {
      const blocker = path.join(dir, "blocker");
      await writeFile(blocker, "not a directory");
      await expect(
        WavFileWriter.open(path.join(blocker, "rec.wav")),
      ).rejects.toThrow(/EEXIST|ENOTDIR/);
    });
  });

  it("open() rejects when the path itself is a directory", async () => {
    await withDir(async (dir) => {
      await expect(WavFileWriter.open(dir)).rejects.toThrow(/EEXIST|EISDIR/);
    });
  });
});

describe("readWavPcm16Channel", () => {
  async function tempFile(name: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const p = await import("node:path");
    const dir = await fs.mkdtemp(p.join(os.tmpdir(), "wav-read-"));
    return {
      file: p.join(dir, name),
      cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
  }
  const close = (a: number, b: number) => Math.abs(a - b) < 1.5 / 32768;

  it("reads one channel or the mix of a stereo file block by block", async () => {
    const { file, cleanup } = await tempFile("stereo.wav");
    const left = Float32Array.from({ length: 1000 }, (_, i) => (i % 100) / 200);
    const right = Float32Array.from({ length: 1000 }, (_, i) => -(i % 50) / 100);
    const w = await WavFileWriter.open(file, 16000, 2);
    w.write([left.subarray(0, 600), right.subarray(0, 600)]);
    w.write([left.subarray(600), right.subarray(600)]);
    await w.close();

    // A 64-byte block holds 16 stereo frames, so reads straddle every boundary.
    const l = await readWavPcm16Channel(file, 0, { blockBytes: 64 });
    expect(l).not.toBeNull();
    expect(l!.channels).toBe(2);
    expect(l!.sampleRate).toBe(16000);
    expect(l!.samples.length).toBe(1000);
    const r = await readWavPcm16Channel(file, 1, { blockBytes: 64 });
    const mix = await readWavPcm16Channel(file, "mix", { blockBytes: 64 });
    for (const i of [0, 1, 15, 16, 17, 599, 600, 601, 999]) {
      expect(close(l!.samples[i], left[i])).toBe(true);
      expect(close(r!.samples[i], right[i])).toBe(true);
      expect(close(mix!.samples[i], (left[i] + right[i]) / 2)).toBe(true);
    }
    await expect(readWavPcm16Channel(file, 2)).rejects.toThrow(RangeError);
    await cleanup();
  });

  it("uses the bytes present when the header was never patched", async () => {
    const { file, cleanup } = await tempFile("crashed.wav");
    const fs = await import("node:fs/promises");
    const samples = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i / 10) / 2);
    await fs.writeFile(
      file,
      Buffer.concat([wavHeader(0, 16000, 1), encodePcm16(samples)]),
    );
    const read = await readWavPcm16Channel(file, 0, { blockBytes: 100 });
    expect(read!.samples.length).toBe(300);
    expect(close(read!.samples[299], samples[299])).toBe(true);
    await cleanup();
  });

  it("returns null for a file that is not 16-bit PCM", async () => {
    const { file, cleanup } = await tempFile("garbage.wav");
    const fs = await import("node:fs/promises");
    await fs.writeFile(file, Buffer.from("not a wave file at all, sorry"));
    expect(await readWavPcm16Channel(file, 0)).toBeNull();
    await cleanup();
  });
});

describe("WavFileWriter exclusive create", () => {
  it("refuses to overwrite an existing file", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const p = await import("node:path");
    const dir = await fs.mkdtemp(p.join(os.tmpdir(), "wav-excl-"));
    const file = p.join(dir, "rec.wav");
    const w = await WavFileWriter.open(file);
    await w.close();
    await expect(WavFileWriter.open(file)).rejects.toThrow(/EEXIST/);
    const stat = await fs.stat(file);
    // Owner read/write only.
    expect(stat.mode & 0o777).toBe(0o600);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

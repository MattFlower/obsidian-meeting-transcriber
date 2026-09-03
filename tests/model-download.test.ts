import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  MODEL_FILES,
  MODEL_REPO,
  downloadModel,
  modelFileUrls,
  diarizationModelEntries,
  downloadFileSet,
} from "../src/model-download";

describe("MODEL_FILES", () => {
  it("lists exactly the four Parakeet model files", () => {
    expect([...MODEL_FILES].sort()).toEqual(
      [
        "decoder.int8.onnx",
        "encoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
      ].sort(),
    );
  });
});

describe("modelFileUrls", () => {
  it("builds Hugging Face resolve URLs for the default repo", () => {
    const urls = modelFileUrls();
    expect(urls).toHaveLength(4);
    expect(urls[0]).toBe(
      `https://huggingface.co/${MODEL_REPO}/resolve/main/encoder.int8.onnx`,
    );
    expect(urls[3]).toBe(
      `https://huggingface.co/${MODEL_REPO}/resolve/main/tokens.txt`,
    );
  });

  it("uses a custom repo id when given", () => {
    const urls = modelFileUrls("me/my-model");
    expect(urls[1]).toBe(
      "https://huggingface.co/me/my-model/resolve/main/decoder.int8.onnx",
    );
  });
});

describe("diarizationModelEntries", () => {
  it("fetches the two diarization models and renames the segmentation file", () => {
    expect(diarizationModelEntries()).toEqual([
      {
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.int8.onnx",
        file: "pyannote-segmentation-3-0.int8.onnx",
      },
      {
        url: "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/nemo_en_titanet_small.onnx",
        file: "nemo_en_titanet_small.onnx",
      },
    ]);
  });
});

describe("downloadFileSet", () => {
  it("saves each entry under its destination name and numbers progress over the set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fileset-"));
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetched.push(url);
      return new Response(`body of ${url}`, { status: 200 });
    }) as unknown as typeof fetch;

    const progress: { file: string; index: number; count: number }[] = [];
    await downloadFileSet(
      [
        { url: "https://example.test/a/model.int8.onnx", file: "renamed.onnx" },
        { url: "https://example.test/b/kept.onnx", file: "kept.onnx" },
      ],
      dir,
      (p) => progress.push({ file: p.file, index: p.index, count: p.count }),
      fakeFetch,
      { minProgressIntervalMs: 0 },
    );

    expect(fetched).toEqual([
      "https://example.test/a/model.int8.onnx",
      "https://example.test/b/kept.onnx",
    ]);
    expect((await readdir(dir)).sort()).toEqual(["kept.onnx", "renamed.onnx"]);
    expect(await readFile(path.join(dir, "renamed.onnx"), "utf8")).toBe(
      "body of https://example.test/a/model.int8.onnx",
    );
    expect(progress[0]).toEqual({ file: "renamed.onnx", index: 0, count: 2 });
    expect(progress[progress.length - 1]).toEqual({
      file: "kept.onnx",
      index: 1,
      count: 2,
    });

    await rm(dir, { recursive: true, force: true });
  });
});

describe("downloadModel (streaming)", () => {
  it("streams each file to disk and reports incremental byte progress", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "parakeet-"));
    const enc = new TextEncoder();
    const chunks = [enc.encode("hello "), enc.encode("world "), enc.encode("!")];
    const expected = "hello world !";

    const fakeFetch = (async (url: string) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      });
      void url;
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const progress: { file: string; received: number }[] = [];
    await downloadModel(
      dir,
      (p) => progress.push({ file: p.file, received: p.received }),
      fakeFetch,
      { minProgressIntervalMs: 0 },
    );

    // Every file was written with the streamed content, and no `.part`
    // temp file is left behind.
    for (const f of MODEL_FILES) {
      const content = await readFile(path.join(dir, f), "utf8");
      expect(content).toBe(expected);
    }
    expect((await readdir(dir)).sort()).toEqual([...MODEL_FILES].sort());

    // Progress is reported incrementally (per chunk), not once at the end.
    const encProgress = progress.filter((p) => p.file === "encoder.int8.onnx");
    expect(encProgress.length).toBe(chunks.length);
    // First report is a partial amount, proving streaming (not buffered).
    expect(encProgress[0].received).toBeLessThan(expected.length);
    // received is monotonically non-decreasing and ends at the full size.
    let prev = 0;
    for (const p of encProgress) {
      expect(p.received).toBeGreaterThanOrEqual(prev);
      prev = p.received;
    }
    expect(encProgress[encProgress.length - 1].received).toBe(expected.length);

    await rm(dir, { recursive: true, force: true });
  });

  it("throttles progress reports but always delivers the first and the final byte count", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "parakeet-"));
    const enc = new TextEncoder();
    const chunks = [enc.encode("aa"), enc.encode("bb"), enc.encode("cc")];
    const fakeFetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const received: number[] = [];
    await downloadModel(
      dir,
      (p) => {
        if (p.file === "tokens.txt") received.push(p.received);
      },
      fakeFetch,
      // A frozen clock: every chunk lands "at once", so only the first
      // report and the forced final one get through.
      { minProgressIntervalMs: 1000, now: () => 0 },
    );
    expect(received).toEqual([2, 6]);
    await rm(dir, { recursive: true, force: true });
  });

  it("removes the partial file and leaves no model file when the body errors mid-stream", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "parakeet-"));
    const enc = new TextEncoder();
    const fakeFetch = (async () => {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(enc.encode("partial "));
          else controller.error(new Error("connection reset"));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const progress: number[] = [];
    await expect(
      downloadModel(dir, (p) => progress.push(p.received), fakeFetch, {
        minProgressIntervalMs: 0,
      }),
    ).rejects.toThrow(/connection reset/);
    // The first chunk was streamed (and reported) before the failure…
    expect(progress).toEqual(["partial ".length]);
    // …but neither the truncated model file nor its .part temp survives, so
    // the "model files present" check cannot be fooled by a half download.
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("throws on a non-OK response", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "parakeet-"));
    const fakeFetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(downloadModel(dir, undefined, fakeFetch)).rejects.toThrow(
      /HTTP 404/,
    );
    await rm(dir, { recursive: true, force: true });
  });
});

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  MODEL_FILES,
  MODEL_REPO,
  downloadModel,
  modelFileUrls,
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
    );

    // Every file was written with the streamed content.
    for (const f of MODEL_FILES) {
      const content = await readFile(path.join(dir, f), "utf8");
      expect(content).toBe(expected);
    }

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

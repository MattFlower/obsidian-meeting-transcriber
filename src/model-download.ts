import { createWriteStream } from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";

/** Hugging Face repo hosting the Parakeet TDT 0.6B v2 int8 ONNX model. */
export const MODEL_REPO =
  "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

/** The four model files required by the recognizer. */
export const MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
] as const;

export type ModelFile = (typeof MODEL_FILES)[number];

/**
 * Build the download URLs for every model file. Pure so it can be tested.
 */
export function modelFileUrls(repoId: string = MODEL_REPO): string[] {
  return MODEL_FILES.map(
    (f) => `https://huggingface.co/${repoId}/resolve/main/${f}`,
  );
}

export interface DownloadProgress {
  file: string;
  received: number;
  total: number | null;
  index: number;
  count: number;
}

/** Resolve when the writable stream has flushed and closed. */
function finishStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.once("close", () => resolve());
    stream.end();
  });
}

/** Resolve when the writable stream has drained (backpressure). */
function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

/**
 * Stream a single file from `url` to `destPath`, writing chunks to disk as
 * they arrive and reporting incremental (byte-level) progress. Falls back to
 * buffering only when the response exposes no web stream body (e.g. some
 * test mocks).
 */
async function downloadOne(
  url: string,
  destPath: string,
  file: string,
  index: number,
  count: number,
  onProgress?: (p: DownloadProgress) => void,
  doFetch?: typeof fetch,
): Promise<void> {
  const doFetchImpl = doFetch ?? fetch;
  const res = await doFetchImpl(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${file}: HTTP ${res.status}`);
  }
  const totalHeader = res.headers.get("content-length");
  const total =
    totalHeader && Number.isFinite(Number(totalHeader))
      ? Number(totalHeader)
      : null;

  const out = createWriteStream(destPath);
  let received = 0;
  const report = () => onProgress?.({ file, received, total, index, count });

  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const buf = Buffer.from(value);
        if (!out.write(buf)) {
          await waitForDrain(out);
        }
        received += buf.length;
        report();
      }
    }
  } else {
    // Fallback for responses without a readable web-stream body.
    const buf = Buffer.from(await res.arrayBuffer());
    out.write(buf);
    received = buf.length;
    report();
  }
  await finishStream(out);
}

/**
 * Download all model files into `destDir`, streaming each to disk and
 * reporting incremental progress via `onProgress`. `fetchImpl` is injectable
 * for tests.
 */
export async function downloadModel(
  destDir: string,
  onProgress?: (p: DownloadProgress) => void,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const urls = modelFileUrls();
  for (let i = 0; i < MODEL_FILES.length; i++) {
    const file = MODEL_FILES[i];
    await downloadOne(
      urls[i],
      path.join(destDir, file),
      file,
      i,
      MODEL_FILES.length,
      onProgress,
      fetchImpl,
    );
  }
}

import { createWriteStream } from "node:fs";
import { promises as fsp } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
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

export interface DownloadOptions {
  /**
   * Minimum milliseconds between two progress reports for the same file
   * (default 250). A 600 MB download arrives in tens of thousands of
   * network chunks, and every report repaints a Notice and the status bar.
   * The first report of a file and the final one (received === total) are
   * always delivered.
   */
  minProgressIntervalMs?: number;
  /** Injectable clock for the throttle (tests). */
  now?: () => number;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 250;

interface ProgressThrottle {
  minIntervalMs: number;
  now: () => number;
}

/**
 * Stream a single file from `url` to `destPath`, writing chunks to disk as
 * they arrive and reporting incremental (byte-level) progress.
 *
 * The bytes go to a sibling `<destPath>.part` file that is renamed into
 * place only once fully written and closed, so an interrupted download never
 * leaves a truncated model file that would pass the "all files present"
 * check and then fail inside the recognizer. On any error the write stream
 * is destroyed and the partial file removed before rethrowing. Falls back to
 * buffering only when the response exposes no web-stream body (e.g. some
 * test mocks).
 */
async function downloadOne(
  url: string,
  destPath: string,
  file: string,
  index: number,
  count: number,
  onProgress: ((p: DownloadProgress) => void) | undefined,
  doFetch: typeof fetch,
  throttle: ProgressThrottle,
): Promise<void> {
  const res = await doFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${file}: HTTP ${res.status}`);
  }
  const totalHeader = res.headers.get("content-length");
  const total =
    totalHeader && Number.isFinite(Number(totalHeader))
      ? Number(totalHeader)
      : null;

  const partPath = `${destPath}.part`;
  const out = createWriteStream(partPath);
  let received = 0;
  let lastReportAt = -Infinity;
  let lastReported = -1;
  const report = (final: boolean) => {
    if (!onProgress) return;
    const now = throttle.now();
    if (!final && now - lastReportAt < throttle.minIntervalMs) return;
    if (received === lastReported) return;
    lastReportAt = now;
    lastReported = received;
    onProgress({ file, received, total, index, count });
  };

  const body = res.body;
  const reader =
    body && typeof body.getReader === "function" ? body.getReader() : null;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const buf = Buffer.from(value);
          if (!out.write(buf)) {
            // Backpressure: wait for the disk to catch up. `once` rejects if
            // the stream errors meanwhile and removes its listeners either
            // way, so a long download does not pile up 'error' listeners.
            await once(out, "drain");
          }
          received += buf.length;
          report(false);
        }
      }
    } else {
      // Fallback for responses without a readable web-stream body.
      const buf = Buffer.from(await res.arrayBuffer());
      out.write(buf);
      received = buf.length;
    }
    out.end();
    // Resolves once the data is flushed and the descriptor closed (fs
    // streams auto-destroy), so the rename below never races the close.
    await finished(out);
  } catch (e) {
    out.destroy();
    await finished(out).catch(() => undefined);
    await reader?.cancel().catch(() => undefined);
    await fsp.rm(partPath, { force: true });
    throw e;
  }
  await fsp.rename(partPath, destPath);
  report(true);
}

/**
 * Download all model files into `destDir`, streaming each to disk and
 * reporting incremental progress via `onProgress`. `fetchImpl` is injectable
 * for tests; `options` tunes progress throttling.
 */
export async function downloadModel(
  destDir: string,
  onProgress?: (p: DownloadProgress) => void,
  fetchImpl?: typeof fetch,
  options?: DownloadOptions,
): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const throttle: ProgressThrottle = {
    minIntervalMs:
      options?.minProgressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
    now: options?.now ?? (() => Date.now()),
  };
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
      fetchImpl ?? fetch,
      throttle,
    );
  }
}

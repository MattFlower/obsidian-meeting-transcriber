# Plan: Anchor sherpa-onnx-node resolution at the installed plugin directory

Date: 2026-08-18
ADW session: 299908e1

## Problem

Inside Obsidian, transcription fails with:

```
Live transcription failed: Cannot find module 'sherpa-onnx-node'
Require stack:
- electron/js2c/renderer_init
```

`src/transcriber.ts` calls bare `require("sherpa-onnx-node")` inside
`transcribe()`. esbuild keeps that require external (deliberately — it is a
native addon and must load at runtime), so it survives into `main.js`.
Obsidian evaluates plugin code in the Electron renderer without a module
directory context, so Node resolves the bare specifier from
`electron/js2c/renderer_init` and never walks into the plugin folder's own
`node_modules` — even though `node_modules/sherpa-onnx-node` and
`node_modules/sherpa-onnx-darwin-arm64` are correctly installed alongside
`main.js` in the plugin folder.

Proven fact: anchoring resolution at the plugin directory works —
`createRequire("<plugin dir>/package.json")("sherpa-onnx-node")` loads the
module cleanly. The fix is to change the resolution base, not the module.

## Approach

Replace the bare `require` with `createRequire` (from `node:module`) anchored
at the installed plugin directory. The plugin directory is derived at runtime
from `adapter.getBasePath()` (already used in `src/main.ts`) plus
`this.manifest.dir` (the vault-relative plugin folder, part of Obsidian's
`PluginManifest`). Both transcription entry points — the file-based command
and the live-recording chunk pump — pass the plugin directory down to
`transcribe()`, since they share the recognizer.

No bundling changes: `sherpa-onnx-node` stays external, and `node:module` is
already external via the `builtin-modules` mapping in `esbuild.config.mjs`.
`package.mjs` already ships `package.json` in the plugin folder (it is in the
`required` list), so `<pluginDir>/package.json` is a valid `createRequire`
anchor. No shipped-file changes.

## Changes

### 1. `src/transcriber.ts`

- Add `import { createRequire } from "node:module";` at the top. (Keeps the
  import static so esbuild marks `node:module` external; the native addon
  itself is still loaded lazily inside the function body.)
- Export a new loader function:

  ```ts
  /**
   * Load sherpa-onnx-node resolved relative to the installed plugin
   * directory, not by bare specifier. Obsidian evaluates plugin code in the
   * Electron renderer without a module directory context, so a bare
   * require("sherpa-onnx-node") resolves from electron/js2c/renderer_init
   * and misses the plugin folder's own node_modules. Anchoring createRequire
   * at <pluginDir>/package.json makes Node walk up from the plugin folder,
   * where package.mjs installs node_modules/sherpa-onnx-node.
   *
   * Exported for tests; called lazily from transcribe() so importing this
   * module never loads the native binary (headless vitest stays safe).
   */
  export function loadSherpaOnnx(pluginDir: string): any {
    const dir = pluginDir.replace(/\/+$/, "");
    const req = createRequire(`${dir}/package.json`);
    return req("sherpa-onnx-node");
  }
  ```

  (Use a minimal structural type instead of `any` if preferred — e.g.
  `{ OfflineRecognizer: new (config: RecognizerConfig) => any }` — but keep
  it simple; the recognizer handle is already untyped today.)
- Change `transcribe()`'s signature from
  `transcribe(pcm, modelDir, sampleRate = 16000)` to
  `transcribe(pcm, modelDir, pluginDir, sampleRate = 16000)`, and replace
  the bare `require("sherpa-onnx-node")` line with
  `const sherpa = loadSherpaOnnx(pluginDir);`.
- Update the doc comment above `transcribe()`: it currently explains the
  lazy bare require; rewrite that paragraph to describe the plugin-dir
  anchored resolution. Keep the note that the addon loads lazily and stays
  an esbuild external. (Leave the ELECTRON_RUN_AS_NODE fallback note as-is.)
- No caching/memoization needed: Node's module cache keys on the resolved
  filename, so repeat calls are cheap after the first load.

### 2. `src/main.ts`

- Add a public method on `MeetingTranscriberPlugin`, mirroring
  `resolveModelDir()`:

  ```ts
  /**
   * Absolute path of the installed plugin folder (…/.obsidian/plugins/<id>).
   * Used as the createRequire anchor so the external native dependency
   * resolves from the plugin folder's own node_modules inside Obsidian's
   * renderer. Returns null when the vault adapter is not the desktop
   * file-system adapter.
   */
  resolvePluginDir(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const dir = path.join(adapter.getBasePath(), this.manifest.dir);
    return dir.split(path.sep).join("/");
  }
  ```

  (`this.manifest.dir` is the vault-relative plugin folder per
  `PluginManifest` in `node_modules/obsidian/obsidian.d.ts`.)
- In `transcribeFile()` (around line 159): compute
  `const pluginDir = this.resolvePluginDir();` next to `modelDirAbs`, widen
  the existing early-return guard to `if (!modelDirAbs || !pluginDir)`, and
  change the call at ~line 207 to
  `await transcribe(samples, modelDirAbs, pluginDir)`.

### 3. `src/live-panel.ts`

- Add `resolvePluginDir(): string | null;` to the `LiveRecordingHost`
  interface (near `resolveModelDir()`, ~line 21). The plugin class satisfies
  it structurally once change 2 lands.
- In `transcribeChunk()` (~line 466): add
  `const pluginDir = this.host.resolvePluginDir();`, widen the guard to
  `if (!modelDir || !pluginDir || !note) return;`, and change the call to
  `await transcribe(pcm, modelDir, pluginDir);`.

### 4. `esbuild.config.mjs`

- No functional change: `sherpa-onnx-node` stays in `external`, and
  `node:module` is already covered by `...builtins.map((b) => \`node:${b}\`)`.
- Optionally extend the existing comment above the `sherpa-onnx-node` entry
  to note that resolution is anchored at the plugin directory via
  `createRequire` at runtime. Comment-only.

### 5. `tests/transcriber.test.ts`

Add a `describe` block covering the plugin-dir-anchored resolution so a
regression to bare `require` fails the suite:

- Build a fake plugin dir in the OS temp dir (outside the repo, so a bare
  require could never accidentally resolve it):

  ```ts
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-dir-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  // fake node_modules/sherpa-onnx-node/{package.json,index.js}
  ```

  The fake `index.js` exports a marker (e.g. `__fake: true`) plus a fake
  `OfflineRecognizer` class implementing
  `createStream()` / `acceptWaveform()` / `decode()` / `getResult()`
  (returning `{ text: "  hello world  " }`) and capturing the constructor
  config for assertions.
- Test 1 (resolution): `loadSherpaOnnx(fakeDir)` returns the fake module —
  assert the marker. This distinguishes anchored resolution from a bare
  require, which in the vitest environment would resolve the repo's real
  `sherpa-onnx-node` dependency (no marker) and fail the assertion.
- Test 2 (end-to-end through the recognizer path):
  `await transcribe(new Float32Array(16000), "models/parakeet", fakeDir)`
  resolves to `"hello world"` (trimmed), and the fake recognizer's captured
  config has `modelConfig.transducer.encoder` ending with
  `models/parakeet/encoder.int8.onnx` — proving `transcribe()` both
  resolves via the plugin dir and still feeds `buildRecognizerConfig`.
- Clean up the temp dir in `afterEach`/`afterAll` with
  `fs.rmSync(dir, { recursive: true, force: true })`.
- Existing tests for `modelFilePaths` / `buildRecognizerConfig` /
  `missingModelFiles` are untouched.

## Out of scope (do not touch)

- Bundling `sherpa-onnx-node` into `main.js` — it is a native addon and
  stays external.
- Hardcoding any absolute path or vault location; everything derives from
  `adapter.getBasePath()` + `this.manifest.dir`.
- `package.mjs`'s shipped file set, recognizer configuration, model
  handling, and the summarize/tagging feature.
- `adws/` and `.claude/`.

## Verification

1. `npm test` — new resolution tests pass, existing suite green.
2. `npx tsc --noEmit` — type-clean (note the `transcribe` signature change
   ripples to exactly two call sites: `src/main.ts` and `src/live-panel.ts`).
3. `npm run build` — esbuild production build succeeds; confirm `main.js`
   still contains no bundled sherpa-onnx code (it stays an external
   `require`/`createRequire` call).
4. Optional runtime smoke check after `npm run package`, from the repo root:

   ```sh
   node -e "const {createRequire}=require('node:module'); const r=createRequire(require('node:path').resolve('dist/obsidian-meeting-transcriber/package.json')); console.log(typeof r('sherpa-onnx-node').OfflineRecognizer)"
   ```

   should print `function`, mirroring what Obsidian's renderer will do.
5. Final manual confirmation (not automatable here): install the packaged
   folder into a vault, run both "Transcribe meeting audio to note" and a
   live recording — the `Cannot find module 'sherpa-onnx-node'` error is
   gone from both paths.

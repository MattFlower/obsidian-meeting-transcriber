# Plugin-directory native module resolution

## What changed

Transcription now resolves `sherpa-onnx-node` from the installed Obsidian plugin directory instead of using a bare module require. `src/transcriber.ts` adds `loadSherpaOnnx(pluginDir)`, which anchors `createRequire` at `<pluginDir>/package.json`, and `transcribe()` now receives that directory. The native addon remains lazy-loaded and external to the build.

`src/main.ts` derives the absolute plugin directory from the desktop adapter’s `getBasePath()` and `this.manifest.dir`. The file-based transcription path passes it to `transcribe()` and stops with the existing desktop-adapter notice if it cannot be resolved. `src/live-panel.ts` adds the directory to `LiveRecordingHost`, checks it in the live chunk path, and passes it to the shared recognizer. Thus both transcription entry points use the corrected resolution base without hardcoded vault or absolute paths.

## Verification coverage

`tests/transcriber.test.ts` creates a temporary plugin directory containing a fake `sherpa-onnx-node`, verifies `loadSherpaOnnx()` loads that module, and exercises `transcribe()` to confirm trimmed output and the expected model encoder path in the recognizer configuration.

Run the project checks:

```sh
npm test
npx tsc --noEmit
npm run build
```

The request and implementation rationale are recorded in `requests/fix-native-module-resolution.md` and `specs/299908e1_plugin-dir-require.md`.

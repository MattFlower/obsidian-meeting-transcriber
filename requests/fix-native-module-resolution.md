Transcription fails at runtime inside Obsidian with:

    Live transcription failed: Cannot find module 'sherpa-onnx-node'
    Require stack:
    - electron/js2c/renderer_init

The native module IS installed correctly. The plugin folder in the vault
contains node_modules/sherpa-onnx-node and node_modules/sherpa-onnx-darwin-arm64
alongside main.js. The files are present; resolving them is what fails.

The cause is the bare `require("sherpa-onnx-node")` at src/transcriber.ts:108,
which esbuild deliberately leaves external so it survives into main.js unbundled.
Obsidian evaluates plugin code in the Electron renderer without a module
directory context, so Node resolves that require starting from
electron/js2c/renderer_init — as the error's require stack shows — and never
walks into the plugin folder's own node_modules.

Evidence that the module itself is fine: anchoring resolution at the installed
plugin directory resolves it successfully. Running
`createRequire("<plugin dir>/package.json")("sherpa-onnx-node")` from that path
loads the module without error. The package is intact; only the resolution base
is wrong.

Where: src/transcriber.ts (the require at line 108), src/main.ts (which already
reaches the vault base path via adapter.getBasePath() at line 235 and has the
plugin manifest), esbuild.config.mjs (sherpa-onnx-node is listed external at
line 24), and tests/.

Done means: transcription resolves the native module relative to the installed
plugin directory instead of by bare require, so it loads inside Obsidian's
renderer; both the live recording path and the existing file-based path get the
fix, since they share the recognizer; a test covers the resolution so this
cannot silently regress; and `npm test`, `npx tsc --noEmit`, and `npm run build`
all pass.

Out of scope: bundling sherpa-onnx-node into main.js — it is a native addon and
must stay external, loaded by the host at runtime. Also out of scope: hardcoding
any absolute path or any vault location, changing package.mjs's set of shipped
files, changing the recognizer configuration or model handling, and the
summarize/tagging feature. Do not modify adws/ or .claude/.

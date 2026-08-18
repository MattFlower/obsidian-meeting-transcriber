// Assembles a self-contained, installable plugin folder under dist/.
//
// The plugin has a runtime native dependency (sherpa-onnx-node) that is kept
// external to the esbuild bundle. It must live in the plugin folder so that
// `require("sherpa-onnx-node")` resolves at runtime inside Obsidian. This
// script copies the built main.js plus the manifest and the native dependency
// into dist/obsidian-meeting-transcriber/.
//
// Run it via: npm run package  (which runs `npm run build` first).

import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.join(root, "dist");
const outDir = path.join(distRoot, "obsidian-meeting-transcriber");

// Match the platform-arch naming used by sherpa-onnx-node/addon.js, e.g.
// darwin-arm64, linux-x64, win-x64.
const platform = os.platform() === "win32" ? "win" : os.platform();
const platformArch = `${platform}-${os.arch()}`;
const platformPkgName = `sherpa-onnx-${platformArch}`;

// Files that must already exist at the repo root (main.js comes from the build).
const required = [
  "manifest.json",
  "versions.json",
  "main.js",
  "README.md",
  "package.json",
];
for (const f of required) {
  await access(path.join(root, f)).catch(() => {
    throw new Error(
      `Missing ${f} at the repo root. Run \`npm run build\` first.`,
    );
  });
}

// Start from a clean dist.
await rm(distRoot, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const f of required) {
  await cp(path.join(root, f), path.join(outDir, f));
}

// Ship the native runtime dependency (external to the bundle). This is two
// sibling packages under node_modules:
//   - sherpa-onnx-node            (the JS wrapper, resolved by require)
//   - sherpa-onnx-<platform>-<arch> (the prebuilt native .node binary that the
//     wrapper loads from a sibling directory at runtime)
const nm = path.join(root, "node_modules");
const wrapperSrc = path.join(nm, "sherpa-onnx-node");
await access(wrapperSrc).catch(() => {
  throw new Error(
    "node_modules/sherpa-onnx-node not found. Run `npm install` first.",
  );
});
await cp(wrapperSrc, path.join(outDir, "node_modules", "sherpa-onnx-node"), {
  recursive: true,
});

const binarySrc = path.join(nm, platformPkgName);
await access(binarySrc).catch(() => {
  throw new Error(
    `node_modules/${platformPkgName} not found (native binary for ` +
      `${platformArch}). Run \`npm install\` on this platform first.`,
  );
});
await cp(binarySrc, path.join(outDir, "node_modules", platformPkgName), {
  recursive: true,
});

// Report what was packaged.
let count = 0;
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else count++;
  }
}
await walk(outDir);

console.log(
  `Packaged ${count} files into ${path.relative(root, outDir)}/ ` +
    `(native binary: ${platformPkgName})`,
);
console.log(
  "Copy the CONTENTS of that folder into your vault's " +
    ".obsidian/plugins/obsidian-meeting-transcriber/ and enable the plugin.",
);

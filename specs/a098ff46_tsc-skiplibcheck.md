# Plan: Make `npx tsc --noEmit` pass (skipLibCheck for broken obsidian.d.ts)

## Problem

`npx tsc --noEmit` exits 2 with three TS2420 errors, all inside
`node_modules/obsidian/obsidian.d.ts` (the Obsidian API's own shipped type
definitions), not this plugin's source:

- `obsidian.d.ts(4245,14)`: `Menu` incorrectly implements `HistoryHandler` (missing `onHistoryBack`)
- `obsidian.d.ts(4477,14)`: `Modal` incorrectly implements `HistoryHandler` (missing `onHistoryBack`)
- `obsidian.d.ts(5201,23)`: `PopoverSuggest<T>` incorrectly implements `HistoryHandler` (missing `onHistoryBack`)

The shipped `obsidian.d.ts` (obsidian ^1.7.2) is internally inconsistent: the
`HistoryHandler` interface declares `onHistoryBack`, but the classes that
`implements HistoryHandler` do not declare it. This is a defect in the
upstream type definitions, and it only surfaces because TypeScript type-checks
declaration files by default. Running with `--skipLibCheck` exits 0, so every
file under `src/` already typechecks clean. Verified by running
`npx tsc --noEmit` (exit 2, only the three errors above) — no errors reference
`src/`.

## Fix

Add `"skipLibCheck": true` to `compilerOptions` in `tsconfig.json`.

`skipLibCheck` only skips type-checking of `.d.ts` declaration files (i.e.,
library typings in `node_modules`). It does **not** weaken checking of the
plugin's own source: `strictNullChecks`, `noImplicitAny`, and all other checks
still fully apply to `src/**/*.ts`. This satisfies the out-of-scope
constraints: nothing in `src/` changes, no `any`/`@ts-ignore`/`@ts-expect-error`
is added, and `node_modules/` is untouched.

This also aligns the bare `tsc --noEmit` invocation with the existing build
script, which already runs `tsc -noEmit -skipLibCheck` (see
`package.json` → `scripts.build`).

## Files to change

### `tsconfig.json` (the only change)

Add one line to `compilerOptions`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES2018",
    "allowJs": true,
    "noImplicitAny": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "isolatedModules": true,
    "strictNullChecks": true,
    "skipLibCheck": true,
    "lib": ["DOM", "ES5", "ES6", "ES7", "ES2018", "ES2020"]
  },
  "include": ["src/**/*.ts"]
}
```

(Exact placement within `compilerOptions` is unimportant; keep the file valid
JSON with the existing 2-space indentation.)

Do **not** touch: anything under `src/`, `node_modules/`, `adws/`, `.claude/`,
`package.json`, or any other file.

## Verification

Run from the repo root and confirm each by exit status:

1. `npx tsc --noEmit` → exit 0, no output (previously exit 2 with 3 errors).
2. `npm test` → exit 0 (vitest suite still passes).
3. `npm run build` → exit 0 (tsc + esbuild production build still succeeds).

## Done means

- `npx tsc --noEmit` exits 0 with no errors.
- `npm test` and `npm run build` both pass.
- No changes outside `tsconfig.json`.

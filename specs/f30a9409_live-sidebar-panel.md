# Plan: Replace the live-recording modal with a dockable sidebar panel

Date: 2026-08-18

## Goal

Move all live-recording UI out of `LiveRecordingModal` (an Obsidian `Modal`
that blocks the vault while recording) into an `ItemView`-based sidebar panel.
The command **"Transcribe live meeting (record audio)"** and the microphone
ribbon icon must open/reveal the panel instead of opening a modal. Every
existing behaviour is preserved; only the hosting surface changes.

## Context

- `src/live-modal.ts` — `LiveRecordingModal extends Modal implements
  LiveSessionOwner`. Owns the `LiveRecordingSession`, the
  `TranscriptOverlapDeduper`, the serial transcription pump, the
  1 s status timer, and all UI (source select, device select, start/stop,
  pause/resume, status line). `LiveRecordingHost` is the structural interface
  between it and the plugin.
- `src/main.ts` — registers the `transcribe-live-recording` command
  (~line 88) and the `microphone` ribbon icon (~line 96), both calling
  `openLiveRecordingModal()`. `claimLiveSession` / `releaseLiveSession`
  delegate to `LiveSessionRegistry` and are typed to `LiveRecordingModal`.
- `src/live.ts` — framework-free session logic (`LiveRecordingSession`,
  `LiveChunker`, `TranscriptOverlapDeduper`, `LiveSessionRegistry`,
  `LiveSessionOwner`). **Do not change.** Tests pin its behaviour.
- `tests/live.test.ts` — headless tests for `src/live.ts` only. Must pass
  unchanged.
- Obsidian API (devDep `obsidian@^1.7.2`): `ItemView` (`contentEl`,
  `getViewType()`, `getDisplayText()`, `getIcon()`, `onOpen()`, `onClose()`),
  `Plugin.registerView(type, creator)`,
  `workspace.getLeavesOfType(type)`, `workspace.getRightLeaf(false)`,
  `leaf.setViewState({ type, active: true })`, `workspace.revealLeaf(leaf)`.
  `revealLeaf` requires app ≥ 1.7.2; `manifest.json` currently declares
  `minAppVersion: "1.4.0"` — bump it to `"1.7.2"`.

## Changes

### 1. `src/live-modal.ts` → `src/live-panel.ts` (rename + rework)

Rename the file to `src/live-panel.ts` (delete the old one). The class
becomes `LiveRecordingPanel extends ItemView implements LiveSessionOwner`.
Keep the same UI, state machine, and helpers; change only the hosting:

- Export `const LIVE_PANEL_VIEW_TYPE = "meeting-transcriber-live"`.
- `LiveRecordingHost`: rename to `LivePanelHost` (or keep the name — either
  is fine, but be consistent) and change the `claimLiveSession` /
  `releaseLiveSession` parameter types from `LiveRecordingModal` to
  `LiveRecordingPanel`. All other members (`settings`, `resolveModelDir`,
  `findMissingModelFiles`, `createNote`, `setStatus`, `isLiveSessionActive`)
  stay as-is; the plugin instance continues to satisfy it structurally.
- Constructor: `constructor(leaf: WorkspaceLeaf, host: LiveRecordingHost)` —
  call `super(leaf)`. Build `deps` and the `LiveRecordingSession` exactly as
  today (same `onChunk` serial pump, same `onError` → Notice + `stopSession`).
- View lifecycle replaces modal lifecycle:
  - `getViewType()` returns `LIVE_PANEL_VIEW_TYPE`.
  - `getDisplayText()` returns `"Live meeting transcription"`.
  - `getIcon()` returns `"microphone"`.
  - `onOpen()` → the body of the old `onOpen` minus `setTitle`: call
    `buildContent()` on `this.contentEl`, `void this.refreshDevices()`,
    `updateStatus()`, start the 1 s `tick()` interval. (`buildContent`,
    `tick`, `updateStatus`, `mirrorToStatusBar`, `setButtonsForState`,
    `refreshDevices`, `clampChunkSeconds`, `formatClock`,
    `correctTranscriptWord` all move over unchanged.)
  - `onClose()` → the old `onClose` semantics, kept verbatim: set `closed`,
    clear the timer; if `startPending` return (keep the claim until
    `startSession()` settles); if `session.isRecording()` then
    `void this.stopSession().catch(() => undefined)` (flush + final
    transcribe), else `host.releaseLiveSession(this)`. This handles the user
    closing the sidebar leaf and plugin unload mid-recording — the tail of
    the meeting is still flushed.
- Session lifecycle methods move over **unchanged in logic**:
  - `startSession()` — guards (`isRecording() || stopping || startPending`),
    `host.isLiveSessionActive()` refusal Notice, model-dir / missing-model
    Notices, `host.claimLiveSession(this)` before capture, `startPending`
    flag, `SYSTEM_AUDIO_UNAVAILABLE` guidance Notice with the
    "(Or switch the source to Microphone.)" suffix, `closed` check after
    start, `createNote("Live recording (${source})", "live-${source}", "")`,
    `deduper.reset()`, button/status refresh.
  - `stopSession()` — final partial-buffer flush through the pump, `_No
    speech detected._` placeholder when `!producedText`, release of the slot
    in `finally`, "Live recording stopped." Notice.
  - `transcribeChunk()` — deduper append + `takeCorrection()` clipped-word
    fix via `correctTranscriptWord` + `appendToTranscriptSection`, writing
    through `this.app.vault.read`/`modify`.
- New status content (explicitly requested): the status area must show
  (a) elapsed **unpaused** time — already `session.elapsedSeconds()` via
  `formatClock`; (b) current transcription activity — the existing
  "Transcribing chunk…" state; and (c) **which note is being written to** —
  add a line under the status row, e.g.
  `statusEl` plus a `noteEl` div (class `live-recording-note`) showing
  `Writing to: ${this.note.basename}` (or the note's path) while a session
  note exists, and empty/none text otherwise. Set it in `startSession` after
  `createNote`, clear it in `stopSession`'s `finally`.
- The class still implements `LiveSessionOwner` (`isRecording()` delegates to
  the session) so `LiveSessionRegistry` keeps working untouched.

### 2. `src/main.ts`

- Import `{ LiveRecordingPanel, LIVE_PANEL_VIEW_TYPE }` from `"./live-panel"`
  instead of `LiveRecordingModal` from `"./live-modal"`.
- In `onload()`, before the command registration:
  ```ts
  this.registerView(
    LIVE_PANEL_VIEW_TYPE,
    (leaf) => new LiveRecordingPanel(leaf, this),
  );
  ```
- Replace `openLiveRecordingModal()` with `openLiveRecordingPanel()`:
  ```ts
  private async openLiveRecordingPanel(): Promise<void> {
    // Reveal the existing panel if the view is already open.
    const existing = this.app.workspace.getLeavesOfType(LIVE_PANEL_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: LIVE_PANEL_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  ```
  Note: the current "already recording → Notice" pre-check is intentionally
  dropped here — revealing the panel while recording is legitimate (it is the
  control surface for the running session). The single-session guard is still
  enforced inside `startSession()` via `claimLiveSession` /
  `isLiveSessionActive`, which covers pending starts too.
- The command callback and ribbon icon callback call
  `void this.openLiveRecordingPanel();`.
- Retype `claimLiveSession` / `releaseLiveSession` parameters from
  `LiveRecordingModal` to `LiveRecordingPanel` (they just forward to
  `this.liveSessions`).
- In `onunload()`, add `this.app.workspace.detachLeavesOfType(LIVE_PANEL_VIEW_TYPE);`
  before the existing comment. (The leaf's `onClose` then stops/flushes any
  in-flight recording.)
- Add a defensive "claim handoff" note for the builder: the registry owner is
  now the panel view. If the workspace restores a second leaf of this type
  after reload, each view is a separate owner; `LiveSessionRegistry.tryClaim`
  already refuses the second claim, so no extra work is needed — do **not**
  add new coordination logic.

### 3. `manifest.json`

- Bump `minAppVersion` from `"1.4.0"` to `"1.7.2"` (required by
  `Workspace.revealLeaf`).

### 4. `tests/live.test.ts`

- **No changes required** — it imports only from `src/live.ts`, which is
  untouched. Verify it still passes.
- Optionally (not required): add a small comment or leave as-is. Do not add
  DOM-dependent tests for the panel.

### 5. `styles.css` (only if present / only if needed)

Check whether the repo has a `styles.css`. The existing UI uses classes
`live-recording-row`, `live-recording-label`, `live-recording-select`,
`live-recording-hint`, `live-recording-status` — if a stylesheet defines them
with modal-specific selectors, adjust the selectors so they also apply inside
the sidebar view, and add a rule for the new `live-recording-note` line. If
there is no stylesheet, no action.

## Out of scope (do not touch)

- `src/live.ts` (session, chunker, deduper, registry).
- File-based transcription, summarize/tagging, chunk length, audio overlap,
  and what text gets written into the note.
- `adws/`, `.claude/`.

## Behaviour checklist (the builder must preserve each)

1. Pause/resume suspend and continue capture without ending the session
   (frames dropped, tracks disabled/enabled, elapsed time freezes).
2. Transcript appended incrementally under `## Transcript` during the
   meeting (serial pump transcribes chunks as they arrive).
3. Chunk-seam de-duplication removes overlap and applies the clipped-word
   correction (`TranscriptOverlapDeduper` + `correctTranscriptWord`).
4. System audio throws explicit loopback guidance when unavailable; the
   microphone is never a silent fallback.
5. Final partial buffer flushed on stop; `_No speech detected._` written when
   nothing was transcribed.
6. Single-session guard refuses a second live session while one is claimed or
   recording, including during a pending start (claim before capture,
   release on every exit path).
7. No `Modal` / `LiveRecordingModal` references remain anywhere in the live
   flow; the note stays readable/editable while recording (sidebar view does
   not block the workspace).

## Verification

1. `grep -rn "LiveRecordingModal\|live-modal" src/ tests/` → no matches.
2. `npm test` — all existing vitest tests pass unchanged.
3. `npx tsc --noEmit` — clean.
4. `npm run build` — clean (runs `tsc -noEmit -skipLibCheck` + esbuild).
5. Manual smoke (if an Obsidian test vault is available): ribbon icon and
   command reveal the sidebar panel; start/pause/resume/stop work from the
   panel; the target note can be opened and edited mid-recording; closing the
   panel leaf while recording stops and flushes the session.

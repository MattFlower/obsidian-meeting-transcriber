import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";

import {
  CAPTURE_PROCESSOR_NAME,
  CAPTURE_WORKLET_SOURCE,
  LiveAudioSource,
  LiveCaptureDeps,
  LiveRecordingSession,
  LiveSessionOwner,
  SYSTEM_AUDIO_UNAVAILABLE,
  TranscriptOverlapDeduper,
  type TranscriptWordCorrection,
} from "./live";
import { appendToTranscriptSection, NO_SPEECH_MARKER } from "./note";
import { missingModelFilesMessage, transcribe } from "./transcriber";
import type { TranscriberSettings } from "./settings";

/**
 * The slice of the plugin the panel needs. The plugin instance satisfies
 * this structurally, so the panel never reaches into plugin privates.
 */
export interface LiveRecordingHost {
  settings: TranscriberSettings;
  resolveModelDir(): string | null;
  resolvePluginDir(): string | null;
  findMissingModelFiles(): string[];
  createNote(
    baseName: string,
    sourceLabel: string,
    transcript: string,
  ): Promise<TFile>;
  /**
   * Set (or clear with "") this owner's line on the shared status bar. The
   * plugin merges lines from concurrent activities, so the panel only ever
   * writes its own.
   */
  setStatus(owner: string, text: string): void;
  /** True when any live recording session in the plugin is active. */
  isLiveSessionActive(): boolean;
  /**
   * Claim the plugin-wide single live-session slot for this panel. Returns
   * false (refusal) when another panel already holds the slot.
   */
  claimLiveSession(panel: LiveRecordingPanel): boolean;
  /** Release the slot (no-op if this panel no longer holds it). */
  releaseLiveSession(panel: LiveRecordingPanel): void;
  /** True once the plugin has begun unloading; pending chunks are skipped. */
  isUnloading(): boolean;
  /**
   * Rewrite the note's `## Transcript` section with S1-mini by Superwhisper.
   * Resolves when done and never rejects: the plugin reports progress and
   * failures itself and keeps the raw text when the model cannot run.
   */
  normalizeNoteTranscript(note: TFile): Promise<void>;
}

function clampChunkSeconds(value: number): number {
  if (!Number.isFinite(value)) return 15;
  return Math.min(60, Math.max(5, Math.round(value)));
}

/** Capture factories over the browser's media devices (production wiring). */
function browserCaptureDeps(): LiveCaptureDeps {
  const md = navigator.mediaDevices;
  return {
    getUserMedia: (constraints) => md.getUserMedia(constraints),
    getDisplayMedia: (constraints) => md.getDisplayMedia(constraints),
    enumerateDevices: () => md.enumerateDevices(),
    createAudioContext: (sampleRate) => new AudioContext({ sampleRate }),
    createCaptureNode: (context) =>
      createWorkletCaptureNode(context as AudioContext),
  };
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function correctTranscriptWord(
  markdown: string,
  correction: TranscriptWordCorrection,
): string {
  const heading = /^##\s+Transcript\s*$/gim.exec(markdown);
  if (!heading) return markdown;

  const sectionStart = heading.index + heading[0].length;
  const afterHeading = markdown.slice(sectionStart);
  const nextHeading = /^##\s+/gm.exec(afterHeading);
  const sectionEnd =
    nextHeading === null ? markdown.length : sectionStart + nextHeading.index;
  const section = markdown.slice(sectionStart, sectionEnd);
  const words = Array.from(section.matchAll(/\S+/g));

  for (let index = words.length - 1; index >= 0; index--) {
    const word = words[index];
    if (word[0] !== correction.previous) continue;
    const wordStart = sectionStart + (word.index ?? 0);
    return (
      markdown.slice(0, wordStart) +
      correction.replacement +
      markdown.slice(wordStart + word[0].length)
    );
  }
  return markdown;
}

/**
 * Install the capture worklet from its inline source and return its node.
 * The module is loaded through a blob: URL because the plugin ships as one
 * bundled file with nothing to serve a worklet script from. A stereo input
 * (some loopback devices) is mixed down to one channel at the node, as the
 * former ScriptProcessorNode(4096, 1, 1) did.
 */
async function createWorkletCaptureNode(
  context: AudioContext,
): Promise<AudioWorkletNode> {
  const url = URL.createObjectURL(
    new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" }),
  );
  try {
    await context.audioWorklet.addModule(url);
  } catch (e) {
    // Chromium reports any module fetch or evaluation failure as a bare
    // AbortError; name the component so the notice is actionable.
    throw new Error(
      `Could not load the capture AudioWorklet: ${(e as Error).message}`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
  return new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    outputChannelCount: [1],
  });
}

export const LIVE_PANEL_VIEW_TYPE = "meeting-transcriber-live";

/** Gives each panel its own status-bar owner tag. */
let panelSequence = 0;

/**
 * Dockable control panel for live meeting recording: pick the audio source
 * (microphone or system audio) and input device, start/stop the session,
 * and pause/resume capture. Finished ~15 s chunks are transcribed with the
 * local Parakeet model and appended to the note as the meeting is spoken.
 */
export class LiveRecordingPanel extends ItemView implements LiveSessionOwner {
  private readonly host: LiveRecordingHost;
  private readonly deps: LiveCaptureDeps;
  /** Owner tag for this panel's line on the shared status bar. */
  private readonly statusOwner: string;
  private readonly session: LiveRecordingSession;
  private readonly deduper = new TranscriptOverlapDeduper();

  private sourceSelect: HTMLSelectElement | null = null;
  private deviceSelect: HTMLSelectElement | null = null;
  private startBtn: HTMLButtonElement | null = null;
  private pauseBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;

  private timer: number | null = null;
  private note: TFile | null = null;
  private pump: Promise<void> = Promise.resolve();
  private transcribing = false;
  private producedText = false;
  private stopping = false;
  private startPending = false;
  private closed = false;

  /**
   * `deps` defaults to the browser's media devices; tests inject fakes so the
   * panel runs headless.
   */
  constructor(
    leaf: WorkspaceLeaf,
    host: LiveRecordingHost,
    deps: LiveCaptureDeps = browserCaptureDeps(),
  ) {
    super(leaf);
    this.host = host;
    this.deps = deps;
    this.statusOwner = `live-panel-${++panelSequence}`;
    this.session = new LiveRecordingSession(this.deps, {
      chunkSeconds: clampChunkSeconds(host.settings.liveChunkSeconds),
      onChunk: (pcm) => {
        // Serial pump: chunks transcribe one at a time in arrival order; a
        // backlog simply waits.
        this.pump = this.pump
          .then(() => this.transcribeChunk(pcm))
          .catch((e) => {
            new Notice(`Live transcription failed: ${(e as Error).message}`, 10000);
          });
      },
      onError: (e) => {
        new Notice(`${e.message} Stopping live recording.`, 10000);
        void this.stopSession();
      },
    });
  }

  getViewType(): string {
    return LIVE_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Live meeting transcription";
  }

  getIcon(): string {
    return "microphone";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.buildContent();
    void this.refreshDevices();
    this.updateStatus();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.stopTicking();
    // Closing the panel while recording ends the session (flush + final
    // transcribe) rather than dropping the tail of the meeting. A pending
    // permission request keeps its claim until startSession() settles, so no
    // other panel can begin capture in the meantime.
    if (this.startPending || this.stopping) return;
    if (this.session.isRecording()) {
      void this.stopSession().catch(() => undefined);
    } else {
      this.host.releaseLiveSession(this);
    }
  }

  /** Whether this panel's capture is live (plugin-wide session owner). */
  isRecording(): boolean {
    return this.session.isRecording();
  }

  // -------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------

  private buildContent(): void {
    const content = this.contentEl;
    content.empty();

    const sourceRow = content.createDiv({ cls: "live-recording-row" });
    sourceRow.createSpan({ text: "Audio source", cls: "live-recording-label" });
    this.sourceSelect = sourceRow.createEl("select", {
      cls: "live-recording-select",
    });
    this.sourceSelect.appendChild(new Option("Microphone", "microphone"));
    this.sourceSelect.appendChild(new Option("System audio", "system"));
    this.sourceSelect.value = this.host.settings.liveAudioSource;
    this.sourceSelect.onchange = () => {
      void this.refreshDevices();
      this.updateStatus();
    };

    const deviceRow = content.createDiv({ cls: "live-recording-row" });
    deviceRow.createSpan({ text: "Input device", cls: "live-recording-label" });
    this.deviceSelect = deviceRow.createEl("select", {
      cls: "live-recording-select",
    });
    this.deviceSelect.appendChild(new Option("System default", ""));
    const deviceHint = content.createDiv({ cls: "live-recording-hint" });
    deviceHint.setText(
      "System audio: most platforms do not expose it directly — select a " +
        "loopback device here (BlackHole on macOS, Stereo Mix / VB-CABLE on " +
        "Windows, a PulseAudio/PipeWire monitor source on Linux). The " +
        "microphone is never used as a silent fallback.",
    );

    const buttonRow = content.createDiv({ cls: "live-recording-row" });
    this.startBtn = buttonRow.createEl("button", {
      text: "Start recording",
      cls: "mod-cta",
    });
    this.startBtn.onClickEvent(() => {
      if (this.session.isRecording()) {
        void this.stopSession();
      } else {
        void this.startSession();
      }
    });
    this.pauseBtn = buttonRow.createEl("button", { text: "Pause" });
    this.pauseBtn.disabled = true;
    this.pauseBtn.onClickEvent(() => {
      // The button stays enabled during the stop flush; a click there must
      // not repaint the panel as idle while teardown is still running.
      if (!this.session.isRecording() || this.stopping) return;
      if (this.session.isPaused()) {
        this.session.resume();
      } else {
        this.session.pause();
      }
      this.refreshUi();
    });

    this.statusEl = content.createDiv({ cls: "live-recording-status" });
    this.noteEl = content.createDiv({ cls: "live-recording-note" });
    this.updateStatus();
  }

  /**
   * The one-second refresh runs only while this panel owns a session: it
   * advances the elapsed clock in the panel and mirrors it to the status
   * bar. An idle panel never touches the status bar, so it cannot erase
   * progress text written by a file transcription or a model download.
   */
  private startTicking(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  private stopTicking(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.updateStatus();
    this.mirrorToStatusBar();
  }

  /** Redraw buttons, panel status and status bar after a state transition. */
  private refreshUi(): void {
    this.setButtonsForState();
    this.tick();
  }

  private updateStatus(): void {
    if (this.statusEl) {
      if (this.transcribing && !this.session.isPaused()) {
        const t = formatClock(this.session.elapsedSeconds());
        this.statusEl.setText(`Transcribing chunk… ${t}`);
      } else if (this.session.isRecording()) {
        const t = formatClock(this.session.elapsedSeconds());
        this.statusEl.setText(
          this.session.isPaused() ? `⏸ Paused ${t}` : `● Recording ${t}`,
        );
      } else {
        this.statusEl.setText("Idle");
      }
    }
    if (this.noteEl) {
      this.noteEl.setText(this.note ? `Writing to: ${this.note.path}` : "");
    }
  }

  /** Push this panel's line to the shared status bar ("" clears it). */
  private mirrorToStatusBar(): void {
    this.host.setStatus(this.statusOwner, this.statusBarText());
  }

  private statusBarText(): string {
    if (!this.transcribing && !this.session.isRecording()) return "";
    const t = formatClock(this.session.elapsedSeconds());
    if (this.transcribing && !this.session.isPaused()) {
      return `● Live: transcribing chunk… ${t}`;
    }
    return this.session.isPaused()
      ? `⏸ Live paused ${t}`
      : `● Live recording ${t}`;
  }

  private setButtonsForState(): void {
    if (!this.startBtn || !this.pauseBtn) return;
    if (this.session.isRecording()) {
      this.startBtn.setText("Stop recording");
      this.startBtn.addClass("mod-warning");
      this.startBtn.removeClass("mod-cta");
      this.pauseBtn.disabled = false;
      this.pauseBtn.setText(this.session.isPaused() ? "Resume" : "Pause");
    } else {
      this.startBtn.setText("Start recording");
      this.startBtn.removeClass("mod-warning");
      this.startBtn.addClass("mod-cta");
      this.pauseBtn.disabled = true;
      this.pauseBtn.setText("Pause");
    }
  }

  private async refreshDevices(): Promise<void> {
    if (!this.deviceSelect) return;
    const previous = this.deviceSelect.value;
    try {
      const devices = await this.deps.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const current = this.deviceSelect.value;
      this.deviceSelect.empty();
      this.deviceSelect.appendChild(new Option("System default", ""));
      for (const d of inputs) {
        const label =
          d.label && d.label.trim().length > 0
            ? d.label
            : `Input device ${d.deviceId.slice(0, 8)}`;
        this.deviceSelect.appendChild(new Option(label, d.deviceId));
      }
      const values = Array.from(this.deviceSelect.options).map(
        (o) => o.value,
      );
      if (values.includes(current)) {
        this.deviceSelect.value = current;
      } else if (values.includes(previous)) {
        this.deviceSelect.value = previous;
      }
    } catch {
      // enumerateDevices can fail before the mic permission is granted;
      // "System default" stays selected.
    }
  }

  // -------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------

  private async startSession(): Promise<void> {
    if (this.session.isRecording() || this.stopping || this.startPending) return;
    if (this.host.isLiveSessionActive()) {
      new Notice(
        "A live recording is already in progress. Stop it before starting another.",
        10000,
      );
      return;
    }

    const modelDir = this.host.resolveModelDir();
    if (!modelDir) {
      new Notice(
        "Transcription requires the desktop file-system adapter.",
        10000,
      );
      return;
    }
    const missing = this.host.findMissingModelFiles();
    if (missing.length > 0) {
      new Notice(missingModelFilesMessage(missing), 15000);
      return;
    }

    const source = (this.sourceSelect?.value ??
      this.host.settings.liveAudioSource) as LiveAudioSource;
    const deviceId = this.deviceSelect?.value || undefined;

    // Claim the plugin-wide slot before capture begins so a concurrent
    // start from another panel is refused; released on every exit path.
    if (!this.host.claimLiveSession(this)) {
      new Notice(
        "A live recording is already in progress. Stop it before starting another.",
        10000,
      );
      return;
    }

    this.startPending = true;
    try {
      await this.session.start(source, deviceId);
    } catch (e) {
      this.startPending = false;
      this.host.releaseLiveSession(this);
      const message = (e as Error).message;
      if (message.startsWith(SYSTEM_AUDIO_UNAVAILABLE)) {
        new Notice(
          `${message} (Or switch the source to Microphone.)`,
          20000,
        );
      } else {
        new Notice(`Could not start recording: ${message}`, 15000);
      }
      return;
    }

    this.startPending = false;
    if (this.closed) {
      try {
        await this.session.stop();
      } finally {
        this.host.releaseLiveSession(this);
      }
      return;
    }

    let note: TFile;
    try {
      note = await this.host.createNote(
        `Live recording (${source})`,
        `live-${source}`,
        "",
      );
    } catch (e) {
      await this.session.stop();
      this.host.releaseLiveSession(this);
      new Notice(`Could not create the note: ${(e as Error).message}`, 10000);
      return;
    }

    // The session may have ended while the note was being created (panel
    // closed, input ended, Stop clicked); stopSession() already tore it
    // down, so do not resurrect it — just leave the note marked the way a
    // stopped session's would be.
    if (this.closed || !this.session.isRecording()) {
      await this.markNoSpeech(note);
      return;
    }

    this.note = note;
    this.producedText = false;
    this.pump = Promise.resolve();
    this.deduper.reset();
    this.refreshUi();
    this.startTicking();
  }

  private async stopSession(): Promise<void> {
    if (!this.session.isRecording() || this.stopping) return;
    this.stopping = true;
    let toNormalize: TFile | null = null;
    try {
      const tail = await this.session.stop();
      if (tail) {
        const pending = this.pump
          .then(() => this.transcribeChunk(tail))
          .catch((e) => {
            new Notice(`Live transcription failed: ${(e as Error).message}`, 10000);
          });
        this.pump = pending;
        await pending;
      } else {
        await this.pump;
      }
      if (this.note && !this.producedText) {
        await this.markNoSpeech(this.note);
      } else if (this.note && this.shouldNormalizeOnStop()) {
        toNormalize = this.note;
      }
    } finally {
      this.stopTicking();
      this.stopping = false;
      this.note = null;
      this.transcribing = false;
      this.host.releaseLiveSession(this);
      this.refreshUi();
      new Notice("Live recording stopped.", 5000);
    }
    // Only after the teardown above: the pump has drained, so no more seam
    // corrections can land in the note, and the session slot is free and the
    // panel idle, so a slow model call never blocks Stop or the next
    // recording. Chunks are never normalized individually: the seam
    // de-duper matches words across chunks, and rewritten words would
    // break it. The host reports progress and failures itself.
    if (toNormalize) {
      await this.host.normalizeNoteTranscript(toNormalize).catch(() => undefined);
    }
  }

  private shouldNormalizeOnStop(): boolean {
    const s = this.host.settings;
    return (
      s.normalizerEnabled === true &&
      s.normalizeLiveOnStop === true &&
      !this.host.isUnloading()
    );
  }

  /** Record in the note that the session produced no transcript text. */
  private async markNoSpeech(note: TFile): Promise<void> {
    try {
      await this.app.vault.process(note, (content) =>
        appendToTranscriptSection(content, NO_SPEECH_MARKER),
      );
    } catch {
      // The note may have been deleted or renamed meanwhile.
    }
  }

  private async transcribeChunk(pcm: Float32Array): Promise<void> {
    const modelDir = this.host.resolveModelDir();
    const pluginDir = this.host.resolvePluginDir();
    const note = this.note;
    // Once the plugin is unloading, the recognizer has been released; a
    // pending chunk must not rebuild it in a dead plugin.
    if (!modelDir || !pluginDir || !note || this.host.isUnloading()) return;
    this.transcribing = true;
    this.updateStatus();
    this.mirrorToStatusBar();
    try {
      const text = await transcribe(pcm, modelDir, pluginDir);
      if (text) {
        this.producedText = true;
        const deduped = this.deduper.append(text);
        const correction = this.deduper.takeCorrection();
        if (deduped || correction) {
          // vault.process is an atomic read-modify-write, so an edit the
          // user makes in the open note between chunks is never overwritten
          // by a copy read a moment earlier.
          await this.app.vault.process(note, (content) => {
            const corrected = correction
              ? correctTranscriptWord(content, correction)
              : content;
            return deduped
              ? appendToTranscriptSection(corrected, deduped)
              : corrected;
          });
        }
      }
    } finally {
      this.transcribing = false;
      this.updateStatus();
      this.mirrorToStatusBar();
    }
  }
}

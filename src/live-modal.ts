import { App, Modal, Notice, TFile } from "obsidian";

import {
  LiveAudioSource,
  LiveCaptureDeps,
  LiveRecordingSession,
  LiveSessionOwner,
  SYSTEM_AUDIO_UNAVAILABLE,
  TranscriptOverlapDeduper,
  type TranscriptWordCorrection,
} from "./live";
import { appendToTranscriptSection } from "./note";
import { transcribe } from "./transcriber";
import type { TranscriberSettings } from "./settings";

/**
 * The slice of the plugin the modal needs. The plugin instance satisfies
 * this structurally, so the modal never reaches into plugin privates.
 */
export interface LiveRecordingHost {
  settings: TranscriberSettings;
  resolveModelDir(): string | null;
  findMissingModelFiles(): string[];
  createNote(
    baseName: string,
    sourceLabel: string,
    transcript: string,
  ): Promise<TFile>;
  setStatus(text: string): void;
  /** True when any live recording session in the plugin is active. */
  isLiveSessionActive(): boolean;
  /**
   * Claim the plugin-wide single live-session slot for this modal. Returns
   * false (refusal) when another modal already holds the slot.
   */
  claimLiveSession(modal: LiveRecordingModal): boolean;
  /** Release the slot (no-op if this modal no longer holds it). */
  releaseLiveSession(modal: LiveRecordingModal): void;
}

function clampChunkSeconds(value: number): number {
  if (!Number.isFinite(value)) return 15;
  return Math.min(60, Math.max(5, Math.round(value)));
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
 * Interactive control for live meeting recording: pick the audio source
 * (microphone or system audio) and input device, start/stop the session,
 * and pause/resume capture. Finished ~15 s chunks are transcribed with the
 * local Parakeet model and appended to the note as the meeting is spoken.
 */
export class LiveRecordingModal extends Modal implements LiveSessionOwner {
  private readonly host: LiveRecordingHost;
  private readonly deps: LiveCaptureDeps;
  private readonly session: LiveRecordingSession;
  private readonly deduper = new TranscriptOverlapDeduper();

  private sourceSelect: HTMLSelectElement | null = null;
  private deviceSelect: HTMLSelectElement | null = null;
  private startBtn: HTMLButtonElement | null = null;
  private pauseBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;

  private timer: number | null = null;
  private note: TFile | null = null;
  private pump: Promise<void> = Promise.resolve();
  private transcribing = false;
  private producedText = false;
  private stopping = false;
  private startPending = false;
  private closed = false;

  constructor(app: App, host: LiveRecordingHost) {
    super(app);
    this.host = host;
    const md = navigator.mediaDevices;
    this.deps = {
      getUserMedia: (constraints) => md.getUserMedia(constraints),
      getDisplayMedia: (constraints) => md.getDisplayMedia(constraints),
      enumerateDevices: () => md.enumerateDevices(),
      createAudioContext: (sampleRate) =>
        new AudioContext({ sampleRate }),
    };
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

  onOpen(): void {
    this.closed = false;
    this.setTitle("Transcribe live meeting");
    this.buildContent();
    void this.refreshDevices();
    this.updateStatus();
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  onClose(): void {
    this.closed = true;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    // Closing the modal while recording ends the session (flush + final
    // transcribe) rather than dropping the tail of the meeting. A pending
    // permission request keeps its claim until startSession() settles, so no
    // other modal can begin capture in the meantime.
    if (this.startPending) return;
    if (this.session.isRecording()) {
      void this.stopSession().catch(() => undefined);
    } else {
      this.host.releaseLiveSession(this);
    }
  }

  /** Whether this modal's capture is live (plugin-wide session owner). */
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
      if (this.session.isPaused()) {
        this.session.resume();
      } else {
        this.session.pause();
      }
      this.updateStatus();
    });

    this.statusEl = content.createDiv({ cls: "live-recording-status" });
    this.updateStatus();
  }

  private tick(): void {
    this.updateStatus();
    this.mirrorToStatusBar();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    if (this.transcribing) {
      this.statusEl.setText("Transcribing chunk…");
      return;
    }
    if (this.session.isRecording()) {
      const t = formatClock(this.session.elapsedSeconds());
      this.statusEl.setText(
        this.session.isPaused() ? `⏸ Paused ${t}` : `● Recording ${t}`,
      );
    } else {
      this.statusEl.setText("Idle");
    }
  }

  private mirrorToStatusBar(): void {
    if (this.session.isRecording()) {
      const t = formatClock(this.session.elapsedSeconds());
      this.host.setStatus(
        this.session.isPaused()
          ? `⏸ Live paused ${t}`
          : `● Live recording ${t}`,
      );
    } else {
      this.host.setStatus("");
    }
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
      new Notice(
        "Parakeet model files are missing: " +
          missing.join(", ") +
          ". Run the 'Download Parakeet model' command first.",
        15000,
      );
      return;
    }

    const source = (this.sourceSelect?.value ??
      this.host.settings.liveAudioSource) as LiveAudioSource;
    const deviceId = this.deviceSelect?.value || undefined;

    // Claim the plugin-wide slot before capture begins so a concurrent
    // start from another modal is refused; released on every exit path.
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

    try {
      this.note = await this.host.createNote(
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

    this.producedText = false;
    this.pump = Promise.resolve();
    this.deduper.reset();
    this.setButtonsForState();
    this.updateStatus();
    this.mirrorToStatusBar();
  }

  private async stopSession(): Promise<void> {
    if (!this.session.isRecording() || this.stopping) return;
    this.stopping = true;
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
        const note = this.note;
        try {
          const content = await this.app.vault.read(note);
          await this.app.vault.modify(
            note,
            appendToTranscriptSection(content, "_No speech detected._"),
          );
        } catch {
          // The note may have been deleted or renamed meanwhile.
        }
      }
    } finally {
      this.stopping = false;
      this.note = null;
      this.transcribing = false;
      this.host.releaseLiveSession(this);
      this.setButtonsForState();
      this.updateStatus();
      this.mirrorToStatusBar();
      new Notice("Live recording stopped.", 5000);
    }
  }

  private async transcribeChunk(pcm: Float32Array): Promise<void> {
    const modelDir = this.host.resolveModelDir();
    const note = this.note;
    if (!modelDir || !note) return;
    this.transcribing = true;
    this.updateStatus();
    this.host.setStatus("● Live: transcribing chunk…");
    try {
      const text = await transcribe(pcm, modelDir);
      if (text) {
        this.producedText = true;
        const deduped = this.deduper.append(text);
        const correction = this.deduper.takeCorrection();
        if (deduped || correction) {
          const content = await this.app.vault.read(note);
          const corrected = correction
            ? correctTranscriptWord(content, correction)
            : content;
          const updated = deduped
            ? appendToTranscriptSection(corrected, deduped)
            : corrected;
          if (updated !== content) {
            await this.app.vault.modify(note, updated);
          }
        }
      }
    } finally {
      this.transcribing = false;
      this.updateStatus();
      this.mirrorToStatusBar();
    }
  }
}

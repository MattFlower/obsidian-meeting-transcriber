import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";

import {
  CAPTURE_PROCESSOR_NAME,
  CAPTURE_WORKLET_SOURCE,
  isSilent,
  laneLabel,
  lanesForSource,
  LIVE_SAMPLE_RATE,
  loopbackLane,
  LiveAudioSource,
  LiveCaptureDeps,
  LiveRecordingSession,
  LiveSessionOwner,
  spreadWords,
  SYSTEM_AUDIO_UNAVAILABLE,
  TranscriptOverlapDeduper,
  type LaneWord,
  type LiveAudioSink,
  type LiveFrame,
  type LiveLane,
  type LiveSpeakerSource,
  type LiveWindow,
  type TranscriptWordCorrection,
} from "./live";
import {
  appendToTranscriptSection,
  appendTurnsToTranscriptSection,
  NO_SPEECH_MARKER,
} from "./note";
import { buildTurns } from "./speakers";
import { missingDiarizationModelFilesMessage } from "./diarize";
import {
  missingModelFilesMessage,
  transcribeWithTimestamps,
} from "./transcriber";
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
  findMissingDiarizationModelFiles(): string[];
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
  /**
   * Open the temporary audio file a session records into (one channel per
   * lane) so the speaker pass can run when it stops. Resolves null, after
   * reporting why, when the file cannot be created; recording goes on.
   */
  openLiveAudioSink(
    note: TFile,
    channels: number,
  ): Promise<LiveAudioSink | null>;
  /**
   * Run the speaker pass on a stopped session's note from the words it
   * transcribed and the audio it kept, then delete that audio. Resolves
   * when done and never rejects; the plugin reports progress and failures.
   */
  assignSpeakersToLiveNote(
    note: TFile,
    source: LiveSpeakerSource,
  ): Promise<void>;
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
    createCaptureNode: (context, numberOfInputs) =>
      createWorkletCaptureNode(context as AudioContext, numberOfInputs),
  };
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Rewrite the last occurrence of a clipped seam word in the transcript
 * section. With a `label`, only the section's last `**label:**` paragraph
 * is searched, so a correction for one lane never lands in the other
 * lane's text when both happen to end on the same word.
 */
function correctTranscriptWord(
  markdown: string,
  correction: TranscriptWordCorrection,
  label = "",
): string {
  const heading = /^##\s+Transcript\s*$/gim.exec(markdown);
  if (!heading) return markdown;

  const sectionStart = heading.index + heading[0].length;
  const afterHeading = markdown.slice(sectionStart);
  const nextHeading = /^##\s+/gm.exec(afterHeading);
  const sectionEnd =
    nextHeading === null ? markdown.length : sectionStart + nextHeading.index;

  let rangeStart = sectionStart;
  let rangeEnd = sectionEnd;
  if (label) {
    const marker = `**${label}:**`;
    const at = markdown.lastIndexOf(marker, sectionEnd);
    if (at < sectionStart) return markdown;
    rangeStart = at + marker.length;
    const paragraphEnd = markdown.indexOf("\n\n", rangeStart);
    if (paragraphEnd !== -1 && paragraphEnd < sectionEnd) rangeEnd = paragraphEnd;
  }
  const range = markdown.slice(rangeStart, rangeEnd);
  const words = Array.from(range.matchAll(/\S+/g));

  for (let index = words.length - 1; index >= 0; index--) {
    const word = words[index];
    if (word[0] !== correction.previous) continue;
    const wordStart = rangeStart + (word.index ?? 0);
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
 * former ScriptProcessorNode(4096, 1, 1) did. With two inputs (microphone
 * and loopback) the processor posts both lanes per frame.
 */
async function createWorkletCaptureNode(
  context: AudioContext,
  numberOfInputs: number,
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
    numberOfInputs,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    outputChannelCount: [1],
  });
}

export const LIVE_PANEL_VIEW_TYPE = "meeting-transcriber-live";

/** Gives each panel its own status-bar owner tag. */
let panelSequence = 0;

const SOURCE_NAMES: Record<LiveAudioSource, string> = {
  microphone: "microphone",
  system: "system",
  both: "microphone + system",
};

/**
 * Dockable control panel for live meeting recording: pick the audio source
 * (microphone, system audio, or both), the input device(s), start/stop the
 * session, and pause/resume capture. Finished ~15 s windows are transcribed
 * with the local Parakeet model and appended to the note as the meeting is
 * spoken; with both sources the microphone's words are labelled `Me` and
 * the system audio's `Others`, in time order. When the speaker pass is
 * enabled the session also records its audio to a temporary file so the
 * plugin can label the individual speakers once it stops.
 */
export class LiveRecordingPanel extends ItemView implements LiveSessionOwner {
  private readonly host: LiveRecordingHost;
  private readonly deps: LiveCaptureDeps;
  /** Owner tag for this panel's line on the shared status bar. */
  private readonly statusOwner: string;
  private readonly session: LiveRecordingSession;
  /** One seam de-duper per lane: each lane is its own overlapping stream. */
  private dedupers = new Map<LiveLane, TranscriptOverlapDeduper>();
  private lanes: LiveLane[] = ["mixed"];
  private activeSource: LiveAudioSource = "microphone";
  /** Label of the loopback device in use, for the silent-device notice. */
  private loopbackDeviceName = "";
  private silentLoopbackWindows = 0;
  private warnedSilentLoopback = false;
  /** Every word written this session, on the session timeline, for the speaker pass. */
  private sessionWords: LaneWord[] = [];
  private audioSink: LiveAudioSink | null = null;
  /**
   * Frames captured before the audio file was open (creating the note takes
   * a moment); null when the session does not record audio at all.
   */
  private pendingFrames: LiveFrame[] | null = null;

  private sourceSelect: HTMLSelectElement | null = null;
  private deviceSelect: HTMLSelectElement | null = null;
  private deviceLabel: HTMLElement | null = null;
  private micRow: HTMLElement | null = null;
  private micSelect: HTMLSelectElement | null = null;
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
      onWindow: (window) => {
        // Serial pump: windows transcribe one at a time in arrival order; a
        // backlog simply waits.
        this.pump = this.pump
          .then(() => this.transcribeWindow(window))
          .catch((e) => {
            new Notice(`Live transcription failed: ${(e as Error).message}`, 10000);
          });
      },
      onFrame: (frame) => this.captureFrame(frame),
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
    this.sourceSelect.appendChild(
      new Option("Microphone + system audio", "both"),
    );
    this.sourceSelect.value = this.host.settings.liveAudioSource;
    this.sourceSelect.onchange = () => {
      this.updateSourceUi();
      void this.refreshDevices();
      this.updateStatus();
    };

    const micRow = content.createDiv({ cls: "live-recording-row" });
    micRow.createSpan({ text: "Microphone", cls: "live-recording-label" });
    this.micSelect = micRow.createEl("select", { cls: "live-recording-select" });
    this.micSelect.appendChild(new Option("System default", ""));
    this.micRow = micRow;

    const deviceRow = content.createDiv({ cls: "live-recording-row" });
    this.deviceLabel = deviceRow.createSpan({
      text: "Input device",
      cls: "live-recording-label",
    });
    this.deviceSelect = deviceRow.createEl("select", {
      cls: "live-recording-select",
    });
    this.deviceSelect.appendChild(new Option("System default", ""));
    const deviceHint = content.createDiv({ cls: "live-recording-hint" });
    deviceHint.setText(
      "System audio: most platforms do not expose it directly — select a " +
        "loopback device here (BlackHole on macOS, Stereo Mix / VB-CABLE on " +
        "Windows, a PulseAudio/PipeWire monitor source on Linux). The " +
        "microphone is never used as a silent fallback. Microphone + system " +
        "audio labels your words \"Me\" and the other side \"Others\"; wear " +
        "headphones so the microphone does not pick up the other side too.",
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
    this.updateSourceUi();
    this.updateStatus();
  }

  private selectedSource(): LiveAudioSource {
    return (this.sourceSelect?.value ??
      this.host.settings.liveAudioSource) as LiveAudioSource;
  }

  /** Show the microphone row only when both sources are captured. */
  private updateSourceUi(): void {
    const both = this.selectedSource() === "both";
    if (this.micRow) this.micRow.hidden = !both;
    if (this.deviceLabel) {
      this.deviceLabel.setText(
        both ? "System audio (loopback) device" : "Input device",
      );
    }
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
    const selects = [this.deviceSelect, this.micSelect].filter(
      (select): select is HTMLSelectElement => select !== null,
    );
    if (selects.length === 0) return;
    let inputs: MediaDeviceInfo[];
    try {
      const devices = await this.deps.enumerateDevices();
      inputs = devices.filter((d) => d.kind === "audioinput");
    } catch {
      // enumerateDevices can fail before the mic permission is granted;
      // "System default" stays selected.
      return;
    }
    for (const select of selects) {
      const previous = select.value;
      select.empty();
      select.appendChild(new Option("System default", ""));
      for (const d of inputs) {
        const label =
          d.label && d.label.trim().length > 0
            ? d.label
            : `Input device ${d.deviceId.slice(0, 8)}`;
        select.appendChild(new Option(label, d.deviceId));
      }
      const values = Array.from(select.options).map((o) => o.value);
      if (values.includes(previous)) select.value = previous;
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

    const source = this.selectedSource();
    const deviceId = this.deviceSelect?.value || undefined;
    const micDeviceId =
      source === "both" ? this.micSelect?.value || undefined : undefined;

    // Claim the plugin-wide slot before capture begins so a concurrent
    // start from another panel is refused; released on every exit path.
    if (!this.host.claimLiveSession(this)) {
      new Notice(
        "A live recording is already in progress. Stop it before starting another.",
        10000,
      );
      return;
    }

    // Decide on audio retention before capture starts: frames that arrive
    // while the note and its audio file are being created are held back so
    // the recording has the same timeline as the transcript.
    this.lanes = lanesForSource(source);
    this.activeSource = source;
    this.loopbackDeviceName = this.selectedDeviceName();
    this.silentLoopbackWindows = 0;
    this.warnedSilentLoopback = false;
    this.pendingFrames = this.wantsAudio() ? [] : null;

    this.startPending = true;
    try {
      await this.session.start(source, deviceId, micDeviceId);
    } catch (e) {
      this.startPending = false;
      this.pendingFrames = null;
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
        this.pendingFrames = null;
        this.host.releaseLiveSession(this);
      }
      return;
    }

    let note: TFile;
    try {
      note = await this.host.createNote(
        `Live recording (${SOURCE_NAMES[source]})`,
        `live-${source}`,
        "",
      );
    } catch (e) {
      await this.session.stop();
      this.pendingFrames = null;
      this.host.releaseLiveSession(this);
      new Notice(`Could not create the note: ${(e as Error).message}`, 10000);
      return;
    }

    // The session may have ended while the note was being created (panel
    // closed, input ended, Stop clicked); stopSession() already tore it
    // down, so do not resurrect it — just leave the note marked the way a
    // stopped session's would be.
    if (this.closed || !this.session.isRecording()) {
      this.pendingFrames = null;
      await this.markNoSpeech(note);
      return;
    }

    this.note = note;
    this.producedText = false;
    this.pump = Promise.resolve();
    this.dedupers.clear();
    this.sessionWords = [];
    this.refreshUi();
    this.startTicking();
    if (this.pendingFrames) await this.openSink(note);
  }

  /** The label of the option selected in the system audio device select. */
  private selectedDeviceName(): string {
    const select = this.deviceSelect;
    if (!select) return "the loopback device";
    const option = Array.from(select.options).find(
      (o) => o.value === select.value,
    );
    return option?.text || "the loopback device";
  }

  /**
   * A loopback device that nothing is routed into delivers silence, and the
   * plugin cannot tell that apart from a quiet meeting except by waiting.
   * After two silent windows in a row from session start, say once what is
   * almost certainly wrong: selecting the device here does not route sound
   * into it.
   */
  private noteSilentLoopback(): void {
    this.silentLoopbackWindows++;
    if (this.silentLoopbackWindows < 2 || this.warnedSilentLoopback) return;
    this.warnedSilentLoopback = true;
    const name = this.loopbackDeviceName;
    new Notice(
      `No audio has reached "${name}" yet. Selecting it here captures from ` +
        "it but does not send sound into it: on macOS open Audio MIDI Setup, " +
        "create a Multi-Output Device containing your headphones or speakers " +
        `and ${name}, and choose it as the output device (system-wide or in ` +
        "the meeting app); on Windows or Linux route the app's output to the " +
        "loopback device.",
      30000,
    );
  }

  /** Whether this session should record its audio for the speaker pass. */
  private wantsAudio(): boolean {
    const s = this.host.settings;
    if (
      s.diarizationEnabled !== true ||
      s.diarizeLiveOnStop !== true ||
      this.host.isUnloading()
    ) {
      return false;
    }
    const missing = this.host.findMissingDiarizationModelFiles();
    if (missing.length > 0) {
      new Notice(
        `${missingDiarizationModelFilesMessage(missing)} Recording without ` +
          "speaker labels.",
        15000,
      );
      return false;
    }
    return true;
  }

  /** Open the audio file and write the frames held back meanwhile. */
  private async openSink(note: TFile): Promise<void> {
    const sink = await this.host.openLiveAudioSink(note, this.lanes.length);
    const pending = this.pendingFrames ?? [];
    this.pendingFrames = null;
    if (!sink) return;
    // The session may have stopped while the file was being created.
    if (!this.session.isRecording() || this.note !== note) {
      await sink.abort().catch(() => undefined);
      return;
    }
    this.audioSink = sink;
    for (const frame of pending) this.captureFrame(frame);
  }

  private captureFrame(frame: LiveFrame): void {
    if (this.audioSink) {
      const present = this.lanes.map((lane) => frame[lane]);
      const length = present.find((pcm) => pcm !== undefined)?.length ?? 0;
      this.audioSink.write(present.map((pcm) => pcm ?? new Float32Array(length)));
    } else if (this.pendingFrames) {
      this.pendingFrames.push(frame);
    }
  }

  private async stopSession(): Promise<void> {
    if (!this.session.isRecording() || this.stopping) return;
    this.stopping = true;
    const note = this.note;
    let toDiarize: { note: TFile; source: LiveSpeakerSource } | null = null;
    let toNormalize: TFile | null = null;
    try {
      const tail = await this.session.stop();
      if (tail) {
        const pending = this.pump
          .then(() => this.transcribeWindow(tail))
          .catch((e) => {
            new Notice(`Live transcription failed: ${(e as Error).message}`, 10000);
          });
        this.pump = pending;
        await pending;
      } else {
        await this.pump;
      }
      const audioPath = await this.finishAudio(
        this.producedText && !this.host.isUnloading(),
      );
      if (note && !this.producedText) {
        await this.markNoSpeech(note);
      } else if (note) {
        if (audioPath && !this.host.isUnloading()) {
          toDiarize = {
            note,
            source: { words: this.sessionWords, audioPath, lanes: this.lanes },
          };
        }
        if (this.shouldNormalizeOnStop()) toNormalize = note;
      }
    } finally {
      this.stopTicking();
      this.stopping = false;
      this.note = null;
      this.transcribing = false;
      this.sessionWords = [];
      this.pendingFrames = null;
      this.host.releaseLiveSession(this);
      this.refreshUi();
      new Notice("Live recording stopped.", 5000);
    }
    // Only after the teardown above: the pump has drained, so no more seam
    // corrections can land in the note, and the session slot is free and the
    // panel idle, so a slow model call never blocks Stop or the next
    // recording. Speakers first, so the normalizer sees turns; windows are
    // never normalized individually because the seam de-duper matches words
    // across them and rewritten words would break it. The host reports
    // progress and failures itself.
    if (toDiarize) {
      await this.host
        .assignSpeakersToLiveNote(toDiarize.note, toDiarize.source)
        .catch(() => undefined);
    }
    if (toNormalize) {
      await this.host.normalizeNoteTranscript(toNormalize).catch(() => undefined);
    }
  }

  /**
   * Close the session's audio file and return its path, or discard it (and
   * return null) when it is not wanted (nothing was said, the plugin is
   * unloading) or it failed. Never throws.
   */
  private async finishAudio(keep: boolean): Promise<string | null> {
    const sink = this.audioSink;
    this.audioSink = null;
    this.pendingFrames = null;
    if (!sink) return null;
    if (!keep) {
      await sink.abort().catch(() => undefined);
      return null;
    }
    try {
      await sink.close();
      if (sink.failed) throw sink.failed;
      return sink.path;
    } catch (e) {
      new Notice(
        `The recording's audio could not be saved (${(e as Error).message}); ` +
          "speakers will not be assigned.",
        10000,
      );
      await sink.abort().catch(() => undefined);
      return null;
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

  private deduperFor(lane: LiveLane): TranscriptOverlapDeduper {
    let deduper = this.dedupers.get(lane);
    if (!deduper) {
      deduper = new TranscriptOverlapDeduper();
      this.dedupers.set(lane, deduper);
    }
    return deduper;
  }

  /** Apply a seam correction to the lane's last recorded word as well. */
  private correctSessionWord(
    lane: LiveLane,
    correction: TranscriptWordCorrection,
  ): void {
    for (let i = this.sessionWords.length - 1; i >= 0; i--) {
      const word = this.sessionWords[i];
      if (word.lane !== lane) continue;
      if (word.text === correction.previous) word.text = correction.replacement;
      return;
    }
  }

  /**
   * Transcribe one window: each lane in turn, seam-deduped against that
   * lane's previous window, then every word placed on the session timeline
   * and the window appended as time-ordered turns (`**Me:**` / `**Others:**`
   * with two lanes, a plain paragraph with one).
   */
  private async transcribeWindow(window: LiveWindow): Promise<void> {
    const modelDir = this.host.resolveModelDir();
    const pluginDir = this.host.resolvePluginDir();
    const note = this.note;
    // Once the plugin is unloading, the recognizer has been released; a
    // pending window must not rebuild it in a dead plugin.
    if (!modelDir || !pluginDir || !note || this.host.isUnloading()) return;
    this.transcribing = true;
    this.updateStatus();
    this.mirrorToStatusBar();
    try {
      const words: LaneWord[] = [];
      const corrections: { label: string; correction: TranscriptWordCorrection }[] = [];
      const loopback = loopbackLane(this.activeSource);
      for (const lane of this.lanes) {
        const pcm = window.lanes[lane];
        if (!pcm) continue;
        if (lane === loopback) {
          // Digital silence from the loopback device is a routing problem,
          // not speech; decoding it would only burn CPU.
          if (isSilent(pcm)) {
            this.noteSilentLoopback();
            continue;
          }
          this.silentLoopbackWindows = 0;
        }
        const result = await transcribeWithTimestamps(pcm, modelDir, pluginDir);
        if (!result.text) continue;
        this.producedText = true;
        const timed =
          result.words.length > 0
            ? result.words
            : spreadWords(result.text, pcm.length / LIVE_SAMPLE_RATE);
        const deduper = this.deduperFor(lane);
        const emitted = deduper.appendWords(timed);
        const correction = deduper.takeCorrection();
        if (correction) {
          corrections.push({ label: laneLabel(lane), correction });
          this.correctSessionWord(lane, correction);
        }
        for (const word of emitted) {
          words.push({
            text: word.text,
            start: window.startSeconds + word.start,
            end: window.startSeconds + word.end,
            lane,
          });
        }
      }
      if (words.length === 0 && corrections.length === 0) return;
      // Array.prototype.sort is stable, so a lane's own order is kept.
      words.sort((a, b) => a.start - b.start);
      this.sessionWords.push(...words);
      // Lane labels are ground truth, so no tiny-turn smoothing here.
      const turns =
        words.length > 0
          ? buildTurns(
              words,
              words.map((word) => laneLabel(word.lane)),
              { minTurnWords: 1 },
            )
          : [];
      // vault.process is an atomic read-modify-write, so an edit the user
      // makes in the open note between windows is never overwritten by a
      // copy read a moment earlier.
      await this.app.vault.process(note, (content) => {
        let next = content;
        for (const { label, correction } of corrections) {
          next = correctTranscriptWord(next, correction, label);
        }
        return appendTurnsToTranscriptSection(next, turns);
      });
    } finally {
      this.transcribing = false;
      this.updateStatus();
      this.mirrorToStatusBar();
    }
  }
}

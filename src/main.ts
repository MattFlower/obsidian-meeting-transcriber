import {
  FileSystemAdapter,
  Notice,
  Plugin,
  SuggestModal,
  TFile,
  TFolder,
} from "obsidian";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, promises as fsp } from "node:fs";

import {
  DEFAULT_SETTINGS,
  TranscriberSettingTab,
  type TranscriberSettings,
} from "./settings";
import { decodeToMono16k, downmixToMono, isAudioFile } from "./audio";
import {
  missingModelFiles,
  missingModelFilesMessage,
  releaseRecognizer,
  transcribe,
  transcribeLongWithTimestamps,
  transcribeWithTimestamps,
  type StructuredTranscript,
} from "./transcriber";
import {
  diarize,
  missingDiarizationModelFiles,
  missingDiarizationModelFilesMessage,
  releaseDiarizer,
  type DiarizationOptions,
} from "./diarize";
import { mixedSpeakerTranscript, speakerTranscript } from "./speakers";
import { decodeWavPcm16, readWavPcm16Channel, WavFileWriter } from "./wav";
import { downloadDiarizationModels, downloadModel } from "./model-download";
import { summarizeTranscript } from "./summarize";
import { normalizeSpeakerTranscript } from "./normalize";
import {
  applySummaryToBody,
  extractTranscriptSection,
  formatLocalDate,
  formatLocalTime,
  linkTargetFromFrontmatterValue,
  mergeSummaryIntoFrontmatter,
  NO_SPEECH_MARKER,
  noteFileName,
  replaceTranscriptSection,
  speakerCountFromFrontmatter,
  SPEAKERS_PROPERTY,
  transcriptionNoteContent,
} from "./note";
import {
  LiveRecordingPanel,
  LIVE_PANEL_VIEW_TYPE,
} from "./live-panel";
import {
  laneLabel,
  LiveSessionRegistry,
  type LiveAudioSink,
  type LiveSpeakerSource,
} from "./live";
import { StatusBoard } from "./status";

/**
 * Meeting Transcriber
 *
 * - Transcribes an audio file already in the vault into a note using the
 *   Parakeet TDT 0.6B v2 (int8) model running locally via sherpa-onnx-node.
 * - Records a live meeting (microphone or system audio) and appends the
 *   transcript to a note in ~15 s chunks as the meeting is spoken, with
 *   pause/resume support.
 * - Summarizes a transcription note with a user-selected backend — a cloud
 *   LLM over its HTTP API (with the user's key), a local LLM server on the
 *   machine, or a local CLI (claude -p / codex exec) using its own login —
 *   adding tags + a description to the frontmatter and a `## Summary`
 *   section at the top of the note so it is easier to search later.
 * - Optionally normalizes transcripts with S1-mini by Superwhisper, a local
 *   text normalizer served by Ollama / llama-server / LM Studio: the raw ASR
 *   text in `## Transcript` is replaced with clean written English, either
 *   automatically (new file transcriptions, live sessions when they stop) or
 *   through the "Normalize transcript with S1-mini" command.
 * - Optionally labels who is speaking with a local diarization model
 *   (pyannote segmentation + TitaNet embeddings via sherpa-onnx): the
 *   transcript becomes `**Speaker N:**` turns aligned on Parakeet's word
 *   timestamps, after a file is transcribed, when a live session stops, or
 *   through the "Assign speakers to transcript" command.
 *
 * Desktop only: the ASR engine is a native Node addon and audio decoding uses
 * the Web Audio API.
 */
/**
 * Prefix of the private per-session folders (created with `mkdtemp`, mode
 * 0700) that hold a live session's audio until its speaker pass ran. A fixed
 * shared folder would let two vaults recording in the same minute open the
 * same file, and a planted symlink redirect the write.
 */
export function liveAudioTempPrefix(): string {
  return path.join(os.tmpdir(), "obsidian-meeting-transcriber-");
}

/** Whether `audioPath` lies in a folder this plugin created for a session. */
export function isLiveAudioTempPath(audioPath: string): boolean {
  const dir = path.dirname(audioPath);
  const prefix = liveAudioTempPrefix();
  return (
    dir.startsWith(prefix) &&
    dir.length > prefix.length &&
    path.dirname(dir) === path.dirname(prefix)
  );
}

/** Remove a session's audio file and its private folder. Never throws. */
async function removeLiveAudio(audioPath: string): Promise<void> {
  if (!isLiveAudioTempPath(audioPath)) return;
  await fsp
    .rm(path.dirname(audioPath), { recursive: true, force: true })
    .catch(() => undefined);
}

/**
 * More distinct voices than a meeting has. Automatic clustering that lands
 * above this is cutting the dendrogram far too fine for the recording, and
 * the labels would be noise; the caller keeps the plain transcript instead
 * and tells the user which two settings fix it.
 */
export const MAX_PLAUSIBLE_SPEAKERS = 12;

function implausibleSpeakerCountMessage(speakers: number): string {
  return (
    `Speaker detection found ${speakers} speakers, far more than a meeting ` +
    `has, so no labels were applied. Add "${SPEAKERS_PROPERTY}: N" (the ` +
    "number of people) to the note's properties, or raise 'Clustering " +
    "threshold' in the plugin settings (try 0.8), then run 'Assign speakers " +
    "to transcript'."
  );
}

/** Only automatic detection can overshoot; an exact count is the user's. */
function isImplausibleSpeakerCount(
  speakers: number,
  opts: DiarizationOptions,
): boolean {
  return opts.numSpeakers <= 0 && speakers > MAX_PLAUSIBLE_SPEAKERS;
}

/** Suffix for a "done" Notice describing what the speaker pass found. */
function speakerSummary(speakers: number | null): string {
  if (speakers === null) return "";
  if (speakers <= 1) return " (one speaker, no labels added)";
  return ` (${speakers} speakers)`;
}

export default class MeetingTranscriberPlugin extends Plugin {
  settings: TranscriberSettings = DEFAULT_SETTINGS;
  /**
   * Owner-tagged lines behind the single status bar item, so concurrent
   * activities (file transcription, model download, live recording) never
   * overwrite each other's progress text. Created in onload() once the
   * status bar item exists, so nothing is recorded as shown before it can
   * actually be rendered.
   */
  private status: StatusBoard | null = null;
  /** Owner tags are per invocation, so concurrent runs never share a line. */
  private statusSequence = 0;
  private downloadingModel = false;
  /** Paths of notes being normalized, so one is never rewritten twice at once. */
  private normalizing = new Set<string>();
  /** Paths of notes having speakers assigned, for the same reason. */
  private diarizing = new Set<string>();
  /** Plugin-wide coordination: at most one live recording session at a time. */
  private liveSessions = new LiveSessionRegistry();
  /** Set at the start of onunload; pending live chunks are then skipped. */
  private unloading = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new TranscriberSettingTab(this.app, this));

    const statusBarItem = this.addStatusBarItem();
    this.status = new StatusBoard((text) => statusBarItem.setText(text));

    this.registerView(
      LIVE_PANEL_VIEW_TYPE,
      (leaf) => new LiveRecordingPanel(leaf, this),
    );

    this.addCommand({
      id: "transcribe-audio-file",
      name: "Transcribe meeting audio to note",
      callback: () => {
        new AudioFileSuggestModal(this.app, (file) => {
          void this.transcribeFile(file);
        }).open();
      },
    });

    this.addCommand({
      id: "download-parakeet-model",
      name: "Download Parakeet model",
      callback: () => {
        void this.downloadModelFiles();
      },
    });

    this.addCommand({
      id: "summarize-transcription",
      name: "Summarize and tag this transcription",
      callback: () => {
        void this.summarizeActiveOrSuggested();
      },
    });

    this.addCommand({
      id: "normalize-transcript",
      name: "Normalize transcript with S1-mini",
      callback: () => {
        void this.normalizeActiveOrSuggested();
      },
    });

    this.addCommand({
      id: "download-diarization-models",
      name: "Download diarization models",
      callback: () => {
        void this.downloadDiarizationModelFiles();
      },
    });

    this.addCommand({
      id: "assign-speakers",
      name: "Assign speakers to transcript",
      callback: () => {
        void this.assignSpeakersActiveOrSuggested();
      },
    });

    this.addCommand({
      id: "transcribe-live-recording",
      name: "Transcribe live meeting (record audio)",
      callback: () => {
        void this.openLiveRecordingPanel();
      },
    });

    this.addRibbonIcon("microphone", "Transcribe live meeting", () => {
      void this.openLiveRecordingPanel();
    });
  }

  /** Open the live-recording panel, or reveal it if it is already open. */
  private async openLiveRecordingPanel(): Promise<void> {
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

  isLiveSessionActive(): boolean {
    return this.liveSessions.isRecording();
  }

  claimLiveSession(panel: LiveRecordingPanel): boolean {
    return this.liveSessions.tryClaim(panel);
  }

  releaseLiveSession(panel: LiveRecordingPanel): void {
    this.liveSessions.release(panel);
  }

  isUnloading(): boolean {
    return this.unloading;
  }

  onunload(): void {
    // Flag first: detaching the panel starts an asynchronous stop whose
    // pending chunks must not rebuild the recognizer released below.
    this.unloading = true;
    this.app.workspace.detachLeavesOfType(LIVE_PANEL_VIEW_TYPE);
    // Drop the cached Parakeet recognizer so its native memory can be
    // reclaimed once the plugin's references are gone.
    releaseRecognizer();
    releaseDiarizer();
    // Obsidian removes registered commands and the status bar item for us.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Set one activity's line on the shared status bar, or clear it with an
   * empty string. `owner` tags the line so a live recording refreshing its
   * clock cannot erase a file transcription's "Transcribing…" (or vice
   * versa); the bar shows every active owner's text.
   */
  setStatus(owner: string, text: string): void {
    this.status?.set(owner, text);
  }

  private newStatusOwner(kind: string): string {
    return `${kind}-${++this.statusSequence}`;
  }

  // ---------------------------------------------------------------------
  // Transcribe
  // ---------------------------------------------------------------------

  private async transcribeFile(file: TFile): Promise<void> {
    const modelDirAbs = this.resolveModelDir();
    const pluginDir = this.resolvePluginDir();
    if (!modelDirAbs || !pluginDir) {
      new Notice(
        "Transcription requires the desktop file-system adapter.",
        10000,
      );
      return;
    }
    const missing = this.findMissingModelFiles();
    if (missing.length > 0) {
      new Notice(missingModelFilesMessage(missing), 15000);
      return;
    }

    const status = this.newStatusOwner("transcribe");
    const notice = new Notice("Decoding audio…");
    this.setStatus(status, "Decoding audio…");
    let samples: Float32Array;
    try {
      const arrayBuffer = await this.app.vault.adapter.readBinary(file.path);
      const audioCtx = new AudioContext();
      try {
        samples = await decodeToMono16k(
          arrayBuffer,
          () => audioCtx,
          (length, rate) => new OfflineAudioContext(1, length, rate),
        );
      } finally {
        void audioCtx.close();
      }
    } catch (e) {
      notice.hide();
      this.setStatus(status, "");
      new Notice(
        `Could not decode ${file.name}: ${(e as Error).message}`,
        10000,
      );
      return;
    }
    notice.hide();

    this.setStatus(status, "Transcribing (this can take a while)…");
    const progress = new Notice("Transcribing… this can take a few minutes.");
    let note: TFile | null = null;
    try {
      const { text, speakers } = await this.transcribeAndLabel(
        samples,
        modelDirAbs,
        pluginDir,
        status,
        progress,
      );
      if (!text) {
        new Notice("Transcription produced no text.", 10000);
        return;
      }
      note = await this.createTranscriptionNote(file, text);
      if (speakers !== null) await this.recordSpeakerCount(note, speakers);
      new Notice(`Transcribed ${file.name}${speakerSummary(speakers)}.`, 8000);
    } catch (e) {
      new Notice(
        `Transcription failed: ${(e as Error).message}`,
        15000,
      );
    } finally {
      progress.hide();
      this.setStatus(status, "");
    }
    // The raw note exists before the model is called, so a slow or failed
    // normalization can never lose the transcription.
    const s = this.settings;
    if (note && s.normalizerEnabled && s.normalizeFileTranscripts) {
      await this.normalizeNoteTranscript(note);
    }
  }

  /**
   * Resolve the absolute path of the configured model directory — the same
   * location the download command writes to. The native recognizer resolves
   * model paths against the process working directory, so we must hand it an
   * absolute path, not the vault-relative setting. Returns null when the vault
   * adapter is not the desktop file-system adapter.
   */
  resolveModelDir(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const dir = path.join(adapter.getBasePath(), this.settings.modelDir);
    return dir.split(path.sep).join("/");
  }

  /**
   * Absolute path of the installed plugin folder. Used as the createRequire
   * anchor so native dependencies resolve from this plugin's node_modules.
   * Returns null for non-desktop vault adapters.
   */
  resolvePluginDir(): string | null {
    const adapter = this.app.vault.adapter;
    const manifestDir = this.manifest.dir;
    if (!(adapter instanceof FileSystemAdapter) || !manifestDir) return null;
    const dir = path.join(adapter.getBasePath(), manifestDir);
    return dir.split(path.sep).join("/");
  }

  findMissingModelFiles(): string[] {
    const modelDirAbs = this.resolveModelDir();
    if (!modelDirAbs) return ["<non-desktop adapter>"];
    return missingModelFiles(modelDirAbs, existsSync);
  }

  /** Absolute path of the diarization model directory (see `resolveModelDir`). */
  resolveDiarizationModelDir(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const dir = path.join(
      adapter.getBasePath(),
      this.settings.diarizationModelDir,
    );
    return dir.split(path.sep).join("/");
  }

  findMissingDiarizationModelFiles(): string[] {
    const dir = this.resolveDiarizationModelDir();
    if (!dir) return ["<non-desktop adapter>"];
    return missingDiarizationModelFiles(dir, existsSync);
  }

  /**
   * Clustering options for one note: its `speakers:` property names the
   * number of people when the user knows it (it can be added while a live
   * recording runs), the plugin setting is only the default.
   */
  private diarizationOptionsFor(file: TFile | null): DiarizationOptions {
    const fromNote = file
      ? speakerCountFromFrontmatter(
          this.app.metadataCache.getFileCache(file)?.frontmatter?.[
            SPEAKERS_PROPERTY
          ],
        )
      : null;
    return {
      numSpeakers: fromNote ?? this.settings.diarizationNumSpeakers,
      threshold: this.settings.diarizationThreshold,
    };
  }

  /**
   * Record how many speakers a pass found in the note's properties, unless
   * the note already says: the number is then one edit away from a rerun
   * with the right count.
   */
  private async recordSpeakerCount(file: TFile, speakers: number): Promise<void> {
    if (speakers < 2) return;
    await this.app.fileManager
      .processFrontMatter(file, (data) => {
        const current = data[SPEAKERS_PROPERTY];
        if (current === undefined || current === null || current === "") {
          data[SPEAKERS_PROPERTY] = speakers;
        }
      })
      .catch(() => undefined);
  }

  private async createTranscriptionNote(
    file: TFile,
    transcript: string,
  ): Promise<TFile> {
    return this.createNote(file.basename, `[[${file.path}]]`, transcript);
  }

  /**
   * Create a transcription note in the output folder and return the created
   * `TFile`. Shared by the file-based and the live-recording paths: `baseName`
   * becomes the note title suffix, `sourceLabel` the frontmatter `source`
   * value (a `[[link]]` for files, `live-<source>` for recordings).
   */
  async createNote(
    baseName: string,
    sourceLabel: string,
    transcript: string,
  ): Promise<TFile> {
    const vault = this.app.vault;
    const folder = this.settings.outputFolder.replace(/^\/+|\/+$/g, "");
    if (folder) {
      const existing = vault.getAbstractFileByPath(folder);
      if (!existing) {
        await vault.createFolder(folder);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(
          `Output path ${folder} exists but is not a folder.`,
        );
      }
    }

    const now = new Date();
    const fileName = noteFileName(now, baseName);
    const dir = folder ? `${folder}/` : "";
    const notePath = `${dir}${fileName}`;

    // Title, frontmatter date, and file name all use local time so they agree
    // on the calendar day; toISOString() is UTC and can already be tomorrow.
    const title = `${formatLocalDate(now)} ${baseName}`;
    const content = transcriptionNoteContent({
      title,
      date: `${formatLocalDate(now)} ${formatLocalTime(now)}`,
      audioLink: sourceLabel,
      transcript,
      tags: [...this.settings.defaultTags],
    });

    // Avoid clobbering an existing note with the same name.
    if (await vault.adapter.exists(notePath)) {
      const stem = fileName.replace(/\.md$/, "");
      const suffix = `${now.getTime()}`;
      const altPath = `${dir}${stem} ${suffix}.md`;
      return vault.create(altPath, content);
    }
    return vault.create(notePath, content);
  }

  // ---------------------------------------------------------------------
  // Model download
  // ---------------------------------------------------------------------

  private async downloadModelFiles(): Promise<void> {
    // Two downloads would stream into the same model files.
    if (this.downloadingModel) {
      new Notice("A model download is already in progress.", 8000);
      return;
    }
    const destDir = this.resolveModelDir();
    if (!destDir) {
      new Notice(
        "Model download requires the desktop file-system adapter.",
        10000,
      );
      return;
    }
    this.downloadingModel = true;
    const status = this.newStatusOwner("model-download");
    const notice = new Notice("Downloading Parakeet model (~600 MB)…");
    this.setStatus(status, "Downloading model…");
    // The download overwrites the model files in place; a cached recognizer
    // would keep serving the old weights, so drop it before writing.
    releaseRecognizer();
    try {
      await downloadModel(destDir, (p) => {
        const pct =
          p.total && p.total > 0
            ? ` (${Math.round((p.received / p.total) * 100)}%)`
            : "";
        notice.messageEl.setText(
          `Downloading ${p.file}${pct} [${p.index + 1}/${p.count}]`,
        );
        this.setStatus(status, `Model ${p.index + 1}/${p.count}: ${p.file}`);
      });
      new Notice("Parakeet model downloaded.", 8000);
    } catch (e) {
      new Notice(`Model download failed: ${(e as Error).message}`, 15000);
    } finally {
      this.downloadingModel = false;
      this.setStatus(status, "");
    }
  }

  private async downloadDiarizationModelFiles(): Promise<void> {
    if (this.downloadingModel) {
      new Notice("A model download is already in progress.", 8000);
      return;
    }
    const destDir = this.resolveDiarizationModelDir();
    if (!destDir) {
      new Notice(
        "Model download requires the desktop file-system adapter.",
        10000,
      );
      return;
    }
    this.downloadingModel = true;
    const status = this.newStatusOwner("model-download");
    const notice = new Notice("Downloading diarization models (~42 MB)…");
    this.setStatus(status, "Downloading diarization models…");
    // As for Parakeet: a cached diarizer would keep the old weights.
    releaseDiarizer();
    try {
      await downloadDiarizationModels(destDir, (p) => {
        const pct =
          p.total && p.total > 0
            ? ` (${Math.round((p.received / p.total) * 100)}%)`
            : "";
        notice.messageEl.setText(
          `Downloading ${p.file}${pct} [${p.index + 1}/${p.count}]`,
        );
        this.setStatus(status, `Model ${p.index + 1}/${p.count}: ${p.file}`);
      });
      new Notice("Diarization models downloaded.", 8000);
    } catch (e) {
      new Notice(`Model download failed: ${(e as Error).message}`, 15000);
    } finally {
      this.downloadingModel = false;
      this.setStatus(status, "");
    }
  }

  // ---------------------------------------------------------------------
  // Speaker pass (diarization)
  // ---------------------------------------------------------------------

  /**
   * Transcribe `samples` and, when the speaker pass is enabled and its
   * models are installed, label who is speaking. The pass never blocks a
   * transcription: missing models, or a recognizer that reports no
   * timestamps, fall back to the plain text with a Notice naming the cause.
   * `speakers` is null when no pass ran.
   */
  private async transcribeAndLabel(
    samples: Float32Array,
    modelDir: string,
    pluginDir: string,
    status: string,
    notice: Notice,
  ): Promise<{ text: string; speakers: number | null }> {
    if (!this.settings.diarizationEnabled) {
      return { text: await transcribe(samples, modelDir, pluginDir), speakers: null };
    }
    const missing = this.findMissingDiarizationModelFiles();
    if (missing.length > 0) {
      new Notice(
        `${missingDiarizationModelFilesMessage(missing)} Transcribing ` +
          "without speaker labels.",
        15000,
      );
      return { text: await transcribe(samples, modelDir, pluginDir), speakers: null };
    }
    const structured = await transcribeWithTimestamps(
      samples,
      modelDir,
      pluginDir,
    );
    if (!structured.text) return { text: "", speakers: null };
    if (structured.words.length === 0) {
      new Notice(
        "The recognizer returned no word timestamps; speakers were not assigned.",
        10000,
      );
      return { text: structured.text, speakers: null };
    }
    return this.labelSpeakers(
      samples,
      structured,
      pluginDir,
      status,
      notice,
      this.diarizationOptionsFor(null),
    );
  }

  /** Diarize `samples` and render `structured` as speaker turns. */
  private async labelSpeakers(
    samples: Float32Array,
    structured: StructuredTranscript,
    pluginDir: string,
    status: string,
    notice: Notice,
    opts: DiarizationOptions,
  ): Promise<{ text: string; speakers: number | null }> {
    const diarizationDir = this.resolveDiarizationModelDir();
    if (!diarizationDir) {
      throw new Error(
        "Speaker assignment requires the desktop file-system adapter.",
      );
    }
    const report = (pct: number | null) => {
      const suffix = pct === null ? "" : ` ${pct}%`;
      notice.messageEl.setText(`Assigning speakers…${suffix}`);
      this.setStatus(status, `Assigning speakers${suffix}`);
    };
    report(null);
    const segments = await diarize(
      samples,
      diarizationDir,
      pluginDir,
      opts,
      ({ processed, total }) =>
        report(total > 0 ? Math.round((processed / total) * 100) : null),
    );
    const result = speakerTranscript(structured.words, segments);
    if (isImplausibleSpeakerCount(result.speakers, opts)) {
      new Notice(implausibleSpeakerCountMessage(result.speakers), 20000);
      return { text: structured.text, speakers: null };
    }
    return { text: result.text || structured.text, speakers: result.speakers };
  }

  private async assignSpeakersActiveOrSuggested(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") {
      await this.assignSpeakersToNote(active);
      return;
    }
    new NoteSuggestModal(
      this.app,
      this.settings.outputFolder,
      "Pick a transcription note to assign speakers to",
      (file) => {
        void this.assignSpeakersToNote(file);
      },
    ).open();
  }

  /** Why the speaker pass cannot run right now, or null when it can. */
  private diarizationUnavailableReason(): string | null {
    if (!this.settings.diarizationEnabled) {
      return "Enable 'Assign speakers to transcripts' in the plugin settings first.";
    }
    if (!this.resolveModelDir() || !this.resolvePluginDir()) {
      return "Speaker assignment requires the desktop file-system adapter.";
    }
    const missing = this.findMissingModelFiles();
    if (missing.length > 0) return missingModelFilesMessage(missing);
    const missingDiarization = this.findMissingDiarizationModelFiles();
    if (missingDiarization.length > 0) {
      return missingDiarizationModelFilesMessage(missingDiarization);
    }
    return null;
  }

  /**
   * Locate and decode the audio behind a transcription note: `audio:` in
   * the frontmatter is the absolute path of a kept live recording, `source:`
   * a `[[link]]` to an audio file in the vault. Returns the channels at
   * 16 kHz, or null after a Notice when there is nothing to decode.
   */
  private async readNoteAudio(file: TFile): Promise<Float32Array[] | null> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const audioPath = linkTargetFromFrontmatterValue(fm?.audio);
    if (audioPath && path.isAbsolute(audioPath)) {
      if (!existsSync(audioPath)) {
        new Notice(`The recording ${audioPath} no longer exists.`, 10000);
        return null;
      }
      // Streamed and mixed to mono on the way in: a kept recording is a
      // plugin WAV, and the command path labels every voice in it.
      const wav = await readWavPcm16Channel(audioPath, "mix");
      if (!wav || wav.sampleRate !== 16000) {
        new Notice(`${audioPath} is not a 16 kHz PCM recording.`, 10000);
        return null;
      }
      return [wav.samples];
    }

    const target = linkTargetFromFrontmatterValue(fm?.source);
    const linked = target
      ? this.app.metadataCache.getFirstLinkpathDest(target, file.path)
      : null;
    if (!linked || !isAudioFile(linked.path)) {
      new Notice(
        "This note has no audio to assign speakers from: its frontmatter " +
          "links no audio file, and a live recording keeps its audio only " +
          "until the speaker pass has run.",
        15000,
      );
      return null;
    }
    const arrayBuffer = await this.app.vault.adapter.readBinary(linked.path);
    const wav = decodeWavPcm16(arrayBuffer);
    if (wav && wav.sampleRate === 16000) return wav.channels;
    const audioCtx = new AudioContext();
    try {
      return [
        await decodeToMono16k(
          arrayBuffer,
          () => audioCtx,
          (length, rate) => new OfflineAudioContext(1, length, rate),
        ),
      ];
    } finally {
      void audioCtx.close();
    }
  }

  /**
   * Delete the temporary recording a note's `audio:` frontmatter points at
   * and drop the field. Only files inside the plugin's own temp folder are
   * ever removed; anything else named in a note is left alone.
   */
  async discardKeptAudio(file: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const audioPath = linkTargetFromFrontmatterValue(fm?.audio);
    if (!audioPath || !path.isAbsolute(audioPath)) return;
    await removeLiveAudio(audioPath);
    await this.app.fileManager
      .processFrontMatter(file, (data) => {
        delete data.audio;
      })
      .catch(() => undefined);
  }

  /**
   * Create the temporary WAV a live session records into, outside the vault
   * (a vault may be synced), in a private folder of its own (see
   * `liveAudioTempPrefix`), deleted once the speaker pass has run.
   */
  async openLiveAudioSink(
    note: TFile,
    channels: number,
  ): Promise<LiveAudioSink | null> {
    let dir: string | null = null;
    try {
      dir = await fsp.mkdtemp(liveAudioTempPrefix());
      const writer = await WavFileWriter.open(
        path.join(dir, "recording.wav"),
        16000,
        channels,
      );
      const folder = dir;
      // Aborting must take the private folder with the file.
      return {
        path: writer.path,
        get failed() {
          return writer.failed;
        },
        write: (lanes) => writer.write(lanes),
        close: () => writer.close(),
        abort: async () => {
          await writer.abort().catch(() => undefined);
          await fsp.rm(folder, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } catch (e) {
      if (dir) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      new Notice(
        `Could not create the recording's audio file (${(e as Error).message}); ` +
          "speakers will not be assigned.",
        10000,
      );
      return null;
    }
  }

  /**
   * The speaker pass for a live session that just stopped: diarize the
   * kept audio (the `others` channel when the microphone was captured
   * separately, so "Me" stays fixed) and relabel the words the session
   * already transcribed, then delete the audio. On any failure the audio
   * is kept and its path written to the note's `audio:` frontmatter so the
   * "Assign speakers to transcript" command can retry. Never rejects.
   */
  async assignSpeakersToLiveNote(
    note: TFile,
    source: LiveSpeakerSource,
  ): Promise<void> {
    const keepForRetry = async (why: string): Promise<void> => {
      await this.app.fileManager
        .processFrontMatter(note, (data) => {
          data.audio = source.audioPath;
        })
        .catch(() => undefined);
      new Notice(
        `${why} The recording's audio was kept; run "Assign speakers to ` +
          `transcript" on ${note.name} to label it from that audio (this ` +
          "replaces the transcript section).",
        20000,
      );
    };
    const reason = this.diarizationUnavailableReason();
    if (reason) {
      await keepForRetry(reason);
      return;
    }
    const pluginDir = this.resolvePluginDir();
    const diarizationDir = this.resolveDiarizationModelDir();
    if (!pluginDir || !diarizationDir) return;
    if (this.diarizing.has(note.path)) {
      await keepForRetry(`Already assigning speakers to ${note.name}.`);
      return;
    }

    this.diarizing.add(note.path);
    const status = this.newStatusOwner("speakers");
    const notice = new Notice("Assigning speakers…", 0);
    this.setStatus(status, "Assigning speakers…");
    let done = false;
    try {
      const content = await this.app.vault.read(note);
      const raw = extractTranscriptSection(content);
      if (raw === null) {
        new Notice(`No "## Transcript" section in ${note.name}.`, 10000);
        done = true;
        return;
      }
      if (raw !== source.expectedTranscript) {
        // The note no longer holds only what the panel wrote: the user
        // edited it during the recording. Rendering from the words would
        // silently discard that work.
        await keepForRetry(
          `The transcript of ${note.name} was edited during the recording, ` +
            "so the automatic speaker pass left it alone.",
        );
        return;
      }
      const diarizeLane = source.lanes.includes("others")
        ? "others"
        : source.lanes[0];
      // Only the diarized channel is decoded, streamed from disk.
      const wav = await readWavPcm16Channel(
        source.audioPath,
        source.lanes.indexOf(diarizeLane),
      );
      if (
        !wav ||
        wav.sampleRate !== 16000 ||
        wav.channels < source.lanes.length
      ) {
        throw new Error("the kept audio could not be read");
      }
      const pcm = wav.samples;
      const report = (pct: number | null) => {
        const suffix = pct === null ? "" : ` ${pct}%`;
        notice.messageEl.setText(`Assigning speakers…${suffix}`);
        this.setStatus(status, `Assigning speakers${suffix}`);
      };
      const opts = this.diarizationOptionsFor(note);
      const segments = await diarize(
        pcm,
        diarizationDir,
        pluginDir,
        opts,
        ({ processed, total }) =>
          report(total > 0 ? Math.round((processed / total) * 100) : null),
      );
      const words = source.words.slice().sort((a, b) => a.start - b.start);
      const fixed = words.map((word) =>
        word.lane === diarizeLane ? null : laneLabel(word.lane),
      );
      const result = mixedSpeakerTranscript(
        words,
        fixed,
        segments,
        laneLabel(diarizeLane),
      );
      if (!result.text) {
        new Notice(`Nothing to label in ${note.name}.`, 8000);
        done = true;
        return;
      }
      if (isImplausibleSpeakerCount(result.speakers, opts)) {
        // Keep the audio: the fix is a property or settings change and a rerun.
        await keepForRetry(implausibleSpeakerCountMessage(result.speakers));
        return;
      }
      let applied = false;
      await this.app.vault.process(note, (current) => {
        if (extractTranscriptSection(current) !== raw) return current;
        applied = true;
        return replaceTranscriptSection(current, result.text);
      });
      if (!applied) {
        await keepForRetry(
          `The transcript in ${note.name} changed while speakers were ` +
            "being assigned; nothing was applied.",
        );
        return;
      }
      done = true;
      await this.recordSpeakerCount(note, result.speakers);
      new Notice(
        `Assigned speakers in ${note.name}${speakerSummary(result.speakers)}.`,
        8000,
      );
    } catch (e) {
      await keepForRetry(`Speaker assignment failed: ${(e as Error).message}.`);
    } finally {
      if (done) await removeLiveAudio(source.audioPath);
      notice.hide();
      this.setStatus(status, "");
      this.diarizing.delete(note.path);
    }
  }

  /**
   * Rewrite the `## Transcript` section of `file` with speaker turns from a
   * fresh timestamped transcription of the note's audio. Mirrors
   * `normalizeNoteTranscript`: never rejects, reports through Notices, and
   * leaves the note untouched when its transcript changed meanwhile.
   */
  async assignSpeakersToNote(file: TFile): Promise<void> {
    const reason = this.diarizationUnavailableReason();
    if (reason) {
      new Notice(reason, 15000);
      return;
    }
    if (this.diarizing.has(file.path)) {
      new Notice(`Already assigning speakers to ${file.name}.`, 8000);
      return;
    }
    if (this.normalizing.has(file.path)) {
      new Notice(`${file.name} is being normalized; run this afterwards.`, 8000);
      return;
    }
    const modelDir = this.resolveModelDir();
    const pluginDir = this.resolvePluginDir();
    if (!modelDir || !pluginDir) return;

    this.diarizing.add(file.path);
    const status = this.newStatusOwner("speakers");
    // Sticky (timeout 0): updated per phase below and hidden in finally.
    const notice = new Notice("Assigning speakers…", 0);
    this.setStatus(status, "Assigning speakers…");
    try {
      const content = await this.app.vault.read(file);
      const raw = extractTranscriptSection(content);
      if (raw === null) {
        new Notice(`No "## Transcript" section in ${file.name}.`, 10000);
        return;
      }
      const channels = await this.readNoteAudio(file);
      if (!channels) return;
      const samples =
        channels.length === 1
          ? channels[0]
          : downmixToMono(channels, channels[0].length);

      notice.messageEl.setText("Assigning speakers… transcribing");
      this.setStatus(status, "Transcribing for speakers…");
      const structured = await transcribeLongWithTimestamps(
        samples,
        modelDir,
        pluginDir,
        16000,
        {
          onProgress: (done, total) => {
            if (total <= 1) return;
            notice.messageEl.setText(
              `Assigning speakers… transcribing ${done}/${total}`,
            );
            this.setStatus(status, `Transcribing ${done}/${total}`);
          },
        },
      );
      if (!structured.text) {
        new Notice(`No speech was recognized in the audio of ${file.name}.`, 10000);
        return;
      }
      if (structured.words.length === 0) {
        new Notice(
          "The recognizer returned no word timestamps; speakers cannot be assigned.",
          10000,
        );
        return;
      }
      const { text, speakers } = await this.labelSpeakers(
        samples,
        structured,
        pluginDir,
        status,
        notice,
        this.diarizationOptionsFor(file),
      );
      // Same optimistic guard as normalization: the note is re-read under
      // Obsidian's write lock and left alone if its transcript changed.
      let applied = false;
      await this.app.vault.process(file, (current) => {
        if (extractTranscriptSection(current) !== raw) return current;
        applied = true;
        return replaceTranscriptSection(current, text);
      });
      if (!applied) {
        new Notice(
          `The transcript in ${file.name} changed while speakers were ` +
            "being assigned; nothing was applied. Run the command again.",
          15000,
        );
        return;
      }
      await this.discardKeptAudio(file);
      if (speakers !== null) await this.recordSpeakerCount(file, speakers);
      new Notice(
        `Assigned speakers in ${file.name}${speakerSummary(speakers)}.`,
        8000,
      );
    } catch (e) {
      new Notice(`Speaker assignment failed: ${(e as Error).message}`, 15000);
    } finally {
      notice.hide();
      this.setStatus(status, "");
      this.diarizing.delete(file.path);
    }
  }

  // ---------------------------------------------------------------------
  // Summarize
  // ---------------------------------------------------------------------

  private async summarizeActiveOrSuggested(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") {
      await this.summarizeFile(active);
      return;
    }
    new NoteSuggestModal(
      this.app,
      this.settings.outputFolder,
      "Pick a transcription note to summarize",
      (file) => {
        void this.summarizeFile(file);
      },
    ).open();
  }

  private async summarizeFile(file: TFile): Promise<void> {
    const s = this.settings;
    if (s.summarizerBackend === "cloud" && !s.llmApiKey) {
      new Notice(
        "Set the cloud LLM API key in settings, or switch the summarization " +
          "backend.",
        15000,
      );
      return;
    }
    if (
      s.summarizerBackend === "local" &&
      (!s.localBaseUrl || !s.localModel)
    ) {
      new Notice(
        "Set the local LLM base URL and model in settings first.",
        15000,
      );
      return;
    }
    if (s.summarizerBackend === "cli" && !s.cliCommand) {
      new Notice(
        "Set the CLI command (e.g. `claude -p`) in settings first.",
        15000,
      );
      return;
    }

    const status = this.newStatusOwner("summarize");
    const notice = new Notice("Summarizing…");
    this.setStatus(status, "Summarizing…");
    try {
      const content = await this.app.vault.read(file);
      const transcript = extractTranscriptSection(content) || content;
      const result = await summarizeTranscript(this.settings, transcript);
      // 1) Insert/replace the `## Summary` section in the body, preserving the
      //    existing frontmatter bytes verbatim. vault.process re-reads the
      //    note under Obsidian's write lock, so edits made while the LLM was
      //    running are kept rather than overwritten with the stale `content`.
      await this.app.vault.process(file, (current) =>
        applySummaryToBody(current, result.summary),
      );
      // 2) Update frontmatter (merge tags, set description) through Obsidian's
      //    frontmatter API so normal Obsidian frontmatter is preserved. Both
      //    steps are idempotent, so re-running the command repairs a note
      //    left half-updated by a failure between them.
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        mergeSummaryIntoFrontmatter(fm, result);
      });
      new Notice(
        `Summarized ${file.name} (tags: ${result.tags.join(", ") || "none"}).`,
        8000,
      );
    } catch (e) {
      new Notice(`Summarize failed: ${(e as Error).message}`, 15000);
    } finally {
      notice.hide();
      this.setStatus(status, "");
    }
  }

  // ---------------------------------------------------------------------
  // Normalize (S1-mini by Superwhisper)
  // ---------------------------------------------------------------------

  private async normalizeActiveOrSuggested(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") {
      await this.normalizeNoteTranscript(active);
      return;
    }
    new NoteSuggestModal(
      this.app,
      this.settings.outputFolder,
      "Pick a transcription note to normalize",
      (file) => {
        void this.normalizeNoteTranscript(file);
      },
    ).open();
  }

  /** Why the normalizer cannot run right now, or null when it can. */
  private normalizerUnavailableReason(): string | null {
    const s = this.settings;
    if (!s.normalizerEnabled) {
      return "Enable S1-mini normalization in the plugin settings first.";
    }
    if (!s.normalizerBaseUrl.trim() || !s.normalizerModel.trim()) {
      return "Set the S1-mini server URL and model name in settings first.";
    }
    return null;
  }

  /**
   * Rewrite the `## Transcript` section of `file` with S1-mini's normalized
   * text. Shared by the command, the file-transcription path and the live
   * panel's stop flow. Never rejects: every failure is reported with a
   * Notice and leaves the raw transcript in the note untouched.
   */
  async normalizeNoteTranscript(file: TFile): Promise<void> {
    const reason = this.normalizerUnavailableReason();
    if (reason) {
      new Notice(reason, 15000);
      return;
    }
    if (this.normalizing.has(file.path)) {
      new Notice(`Already normalizing ${file.name}.`, 8000);
      return;
    }
    if (this.diarizing.has(file.path)) {
      new Notice(
        `Speakers are being assigned to ${file.name}; run this afterwards.`,
        8000,
      );
      return;
    }
    this.normalizing.add(file.path);
    const status = this.newStatusOwner("normalize");
    // Sticky (timeout 0): updated per chunk below and hidden in finally.
    const notice = new Notice("Normalizing with S1-mini…", 0);
    this.setStatus(status, "Normalizing transcript…");
    try {
      const content = await this.app.vault.read(file);
      const raw = extractTranscriptSection(content);
      if (raw === null) {
        new Notice(`No "## Transcript" section in ${file.name}.`, 10000);
        return;
      }
      if (!raw || raw === NO_SPEECH_MARKER) {
        new Notice(`Nothing to normalize in ${file.name}.`, 8000);
        return;
      }
      const result = await normalizeSpeakerTranscript(this.settings, raw, {
        onProgress: ({ chunk, total }) => {
          notice.messageEl.setText(
            `Normalizing with S1-mini… chunk ${chunk}/${total}`,
          );
          this.setStatus(status, `Normalizing ${chunk}/${total}`);
        },
      });
      if (!result.text) {
        new Notice(
          `S1-mini returned no text; ${file.name} was left unchanged.`,
          10000,
        );
        return;
      }
      // vault.process re-reads the note under Obsidian's write lock. If the
      // transcript changed while the model ran (a late live chunk, a user
      // edit), the normalized text no longer corresponds to it: keep the
      // note as it is rather than overwrite the newer text.
      let applied = false;
      await this.app.vault.process(file, (current) => {
        if (extractTranscriptSection(current) !== raw) return current;
        applied = true;
        return replaceTranscriptSection(current, result.text);
      });
      if (!applied) {
        new Notice(
          `The transcript in ${file.name} changed while S1-mini was ` +
            "running; nothing was applied. Run the command again.",
          15000,
        );
        return;
      }
      const chunks = `${result.chunks} chunk${result.chunks === 1 ? "" : "s"}`;
      const kept =
        result.fallbackChunks > 0
          ? `, ${result.fallbackChunks} kept raw text`
          : "";
      // An empty reply to a long chunk is the signature of a server with
      // thinking still on (it blanks long inputs and may still answer short
      // ones), so name the likely fix rather than just the count.
      const hint =
        result.fallbackChunks > 0 && result.emptyChunks > 0
          ? " Empty replies usually mean thinking mode is still on in the " +
            "server; see the README."
          : "";
      new Notice(
        `Normalized ${file.name} (${chunks}${kept}).${hint}`,
        hint ? 15000 : 8000,
      );
    } catch (e) {
      new Notice(`Normalization failed: ${(e as Error).message}`, 15000);
    } finally {
      notice.hide();
      this.setStatus(status, "");
      this.normalizing.delete(file.path);
    }
  }
}

/** Suggest modal listing audio files in the vault. */
class AudioFileSuggestModal extends SuggestModal<TFile> {
  private files: TFile[];
  private onChoose: (f: TFile) => void;

  constructor(
    app: MeetingTranscriberPlugin["app"],
    onChoose: (f: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick an audio file to transcribe");
    this.onChoose = onChoose;
    this.files = app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFile => f instanceof TFile && isAudioFile(f.path));
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.files.filter((f) => f.path.toLowerCase().includes(q));
  }

  renderSuggestion(value: TFile, el: HTMLElement): void {
    el.createEl("div", { text: value.path });
  }

  onChooseSuggestion(item: TFile): void {
    this.onChoose(item);
  }
}

/** Suggest modal listing markdown notes in the output folder. */
class NoteSuggestModal extends SuggestModal<TFile> {
  private notes: TFile[];
  private onChoose: (f: TFile) => void;

  constructor(
    app: MeetingTranscriberPlugin["app"],
    outputFolder: string,
    placeholder: string,
    onChoose: (f: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.onChoose = onChoose;
    const folder = outputFolder.replace(/^\/+|\/+$/g, "");
    this.notes = app.vault
      .getMarkdownFiles()
      .filter((f) => (folder ? f.path.startsWith(`${folder}/`) : true));
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.notes.filter((f) => f.path.toLowerCase().includes(q));
  }

  renderSuggestion(value: TFile, el: HTMLElement): void {
    el.createEl("div", { text: value.path });
  }

  onChooseSuggestion(item: TFile): void {
    this.onChoose(item);
  }
}

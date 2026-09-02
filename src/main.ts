import {
  FileSystemAdapter,
  Notice,
  Plugin,
  SuggestModal,
  TFile,
  TFolder,
} from "obsidian";
import * as path from "node:path";
import { existsSync } from "node:fs";

import {
  DEFAULT_SETTINGS,
  TranscriberSettingTab,
  type TranscriberSettings,
} from "./settings";
import { decodeToMono16k, isAudioFile } from "./audio";
import {
  missingModelFiles,
  missingModelFilesMessage,
  releaseRecognizer,
  transcribe,
} from "./transcriber";
import { downloadModel } from "./model-download";
import { summarizeTranscript } from "./summarize";
import { normalizeTranscript } from "./normalize";
import {
  applySummaryToBody,
  extractTranscriptSection,
  formatLocalDate,
  formatLocalTime,
  mergeSummaryIntoFrontmatter,
  NO_SPEECH_MARKER,
  noteFileName,
  replaceTranscriptSection,
  transcriptionNoteContent,
} from "./note";
import {
  LiveRecordingPanel,
  LIVE_PANEL_VIEW_TYPE,
} from "./live-panel";
import { LiveSessionRegistry } from "./live";
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
 *
 * Desktop only: the ASR engine is a native Node addon and audio decoding uses
 * the Web Audio API.
 */
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
      const text = await transcribe(samples, modelDirAbs, pluginDir);
      if (!text) {
        new Notice("Transcription produced no text.", 10000);
        return;
      }
      note = await this.createTranscriptionNote(file, text);
      new Notice(`Transcribed ${file.name}.`, 8000);
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
      const result = await normalizeTranscript(this.settings, raw, {
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

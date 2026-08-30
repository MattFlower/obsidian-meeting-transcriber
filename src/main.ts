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
import { modelFilePaths, transcribe } from "./transcriber";
import { downloadModel } from "./model-download";
import { summarizeTranscript } from "./summarize";
import {
  applySummaryToBody,
  mergeSummaryIntoFrontmatter,
  noteFileName,
  transcriptionNoteContent,
} from "./note";
import {
  LiveRecordingPanel,
  LIVE_PANEL_VIEW_TYPE,
} from "./live-panel";
import { LiveSessionRegistry } from "./live";

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
 *
 * Desktop only: the ASR engine is a native Node addon and audio decoding uses
 * the Web Audio API.
 */
export default class MeetingTranscriberPlugin extends Plugin {
  settings: TranscriberSettings = DEFAULT_SETTINGS;
  private statusBarItem: HTMLElement | null = null;
  /** Plugin-wide coordination: at most one live recording session at a time. */
  private liveSessions = new LiveSessionRegistry();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new TranscriberSettingTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("");

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

  onunload(): void {
    this.app.workspace.detachLeavesOfType(LIVE_PANEL_VIEW_TYPE);
    // Obsidian removes registered commands and the status bar item for us.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  setStatus(text: string): void {
    if (this.statusBarItem) {
      this.statusBarItem.setText(text);
    }
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
      new Notice(
        "Parakeet model files are missing: " +
          missing.join(", ") +
          ". Run the 'Download Parakeet model' command first.",
        15000,
      );
      return;
    }

    const notice = new Notice("Decoding audio…");
    this.setStatus("Decoding audio…");
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
      this.setStatus("");
      new Notice(
        `Could not decode ${file.name}: ${(e as Error).message}`,
        10000,
      );
      return;
    }
    notice.hide();

    this.setStatus("Transcribing (this can take a while)…");
    const progress = new Notice("Transcribing… this can take a few minutes.");
    try {
      const text = await transcribe(samples, modelDirAbs, pluginDir);
      if (!text) {
        new Notice("Transcription produced no text.", 10000);
        return;
      }
      await this.createTranscriptionNote(file, text);
      new Notice(`Transcribed ${file.name}.`, 8000);
    } catch (e) {
      new Notice(
        `Transcription failed: ${(e as Error).message}`,
        15000,
      );
    } finally {
      progress.hide();
      this.setStatus("");
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
    const paths = modelFilePaths(modelDirAbs);
    return (Object.values(paths) as string[]).filter((p) => !existsSync(p));
  }

  private async createTranscriptionNote(
    file: TFile,
    transcript: string,
  ): Promise<void> {
    await this.createNote(file.basename, `[[${file.path}]]`, transcript);
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

    const title = `${now.toISOString().slice(0, 10)} ${baseName}`;
    const content = transcriptionNoteContent({
      title,
      date: now.toISOString().slice(0, 16).replace("T", " "),
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
    const destDir = this.resolveModelDir();
    if (!destDir) {
      new Notice(
        "Model download requires the desktop file-system adapter.",
        10000,
      );
      return;
    }
    const notice = new Notice("Downloading Parakeet model (~600 MB)…");
    this.setStatus("Downloading model…");
    try {
      await downloadModel(destDir, (p) => {
        const pct =
          p.total && p.total > 0
            ? ` (${Math.round((p.received / p.total) * 100)}%)`
            : "";
        notice.messageEl.setText(
          `Downloading ${p.file}${pct} [${p.index + 1}/${p.count}]`,
        );
        this.setStatus(`Model ${p.index + 1}/${p.count}: ${p.file}`);
      });
      new Notice("Parakeet model downloaded.", 8000);
    } catch (e) {
      new Notice(`Model download failed: ${(e as Error).message}`, 15000);
    } finally {
      this.setStatus("");
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
    new NoteSuggestModal(this.app, this.settings.outputFolder, (file) => {
      void this.summarizeFile(file);
    }).open();
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

    const notice = new Notice("Summarizing…");
    this.setStatus("Summarizing…");
    try {
      const content = await this.app.vault.read(file);
      const transcript = extractTranscript(content) || content;
      const result = await summarizeTranscript(this.settings, transcript);
      // 1) Insert/replace the `## Summary` section in the body, preserving the
      //    existing frontmatter bytes verbatim.
      const updated = applySummaryToBody(content, result.summary);
      await this.app.vault.modify(file, updated);
      // 2) Update frontmatter (merge tags, set description) through Obsidian's
      //    frontmatter API so normal Obsidian frontmatter is preserved.
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
      this.setStatus("");
    }
  }
}

/**
 * Extract the `## Transcript` section from a note (fallback: whole body
 * after the frontmatter). Used as the LLM input for summarization.
 */
function extractTranscript(markdown: string): string {
  const lines = markdown.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Transcript\s*$/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
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
    onChoose: (f: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick a transcription note to summarize");
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

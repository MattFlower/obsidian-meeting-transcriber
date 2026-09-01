import { App, PluginSettingTab, Setting } from "obsidian";
import type MeetingTranscriberPlugin from "./main";
import type { LiveAudioSource } from "./live";
import { releaseRecognizer } from "./transcriber";

export type SummarizerBackend = "cloud" | "local" | "cli";

export interface TranscriberSettings {
  /** Vault-relative directory holding the Parakeet ONNX model files. */
  modelDir: string;
  /** Vault-relative folder where transcription notes are created. */
  outputFolder: string;
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1 */
  llmBaseUrl: string;
  /** API key for the LLM endpoint (stored in the vault's data.json). */
  llmApiKey: string;
  /** Model name passed to the LLM endpoint. */
  llmModel: string;
  /** Which summarization backend the summarize command uses. */
  summarizerBackend: SummarizerBackend;
  /** Base URL of a local OpenAI-compatible LLM server (Ollama / LM Studio). */
  localBaseUrl: string;
  /** Model name passed to the local LLM server. */
  localModel: string;
  /** CLI that reads a prompt on stdin and prints the answer (e.g. "claude -p"). */
  cliCommand: string;
  /** Tags added to every new transcription note. */
  defaultTags: string[];
  /** Pre-selected source for the live recording modal. */
  liveAudioSource: LiveAudioSource;
  /** Seconds of audio per live transcription chunk (clamped 5–60). */
  liveChunkSeconds: number;
}

export const DEFAULT_SETTINGS: TranscriberSettings = {
  modelDir: "models/parakeet",
  outputFolder: "Meetings",
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  summarizerBackend: "cloud",
  localBaseUrl: "http://localhost:11434/v1",
  localModel: "llama3.1",
  cliCommand: "claude -p",
  defaultTags: ["meeting"],
  liveAudioSource: "microphone",
  liveChunkSeconds: 15,
};

export class TranscriberSettingTab extends PluginSettingTab {
  plugin: MeetingTranscriberPlugin;

  constructor(app: App, plugin: MeetingTranscriberPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Model directory")
      .setDesc(
        "Vault-relative folder containing the Parakeet ONNX model files. " +
          "Use the 'Download Parakeet model' command to populate it.",
      )
      .addText((text) =>
        text
          .setPlaceholder("models/parakeet")
          .setValue(this.plugin.settings.modelDir)
          .onChange(async (value) => {
            this.plugin.settings.modelDir = value.trim() || "models/parakeet";
            // The cached recognizer belongs to the previous directory; drop
            // it so the next transcription loads the newly configured model.
            releaseRecognizer();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Transcription output folder")
      .setDesc("Vault-relative folder where transcription notes are created.")
      .addText((text) =>
        text
          .setPlaceholder("Meetings")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || "Meetings";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Summarization backend")
      .setDesc(
        "How the 'Summarize and tag this transcription' command generates " +
          "summaries.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("cloud", "Cloud LLM (HTTP API + key)")
          .addOption("local", "Local LLM (on this machine)")
          .addOption("cli", "Local CLI (claude -p / codex exec)")
          .setValue(this.plugin.settings.summarizerBackend)
          .onChange(async (value) => {
            this.plugin.settings.summarizerBackend =
              value as SummarizerBackend;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.summarizerBackend === "cloud") {
      new Setting(containerEl)
        .setName("Cloud LLM base URL")
        .setDesc(
          "Cloud backend: OpenAI-compatible API base URL, e.g. " +
            "https://api.openai.com/v1",
        )
        .addText((text) =>
          text
            .setPlaceholder("https://api.openai.com/v1")
            .setValue(this.plugin.settings.llmBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.llmBaseUrl = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Cloud LLM API key")
        .setDesc("Cloud backend: used as a Bearer token.")
        .addText((text) =>
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.llmApiKey)
            .onChange(async (value) => {
              this.plugin.settings.llmApiKey = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Cloud LLM model")
        .setDesc("Cloud backend: model name sent to the endpoint, e.g. gpt-4o-mini.")
        .addText((text) =>
          text
            .setPlaceholder("gpt-4o-mini")
            .setValue(this.plugin.settings.llmModel)
            .onChange(async (value) => {
              this.plugin.settings.llmModel = value.trim() || "gpt-4o-mini";
              await this.plugin.saveSettings();
            }),
        );
    } else if (this.plugin.settings.summarizerBackend === "local") {
      new Setting(containerEl)
        .setName("Local LLM base URL")
        .setDesc(
          "Local backend: OpenAI-compatible server on this machine, e.g. " +
            "Ollama http://localhost:11434/v1 or LM Studio " +
            "http://localhost:1234/v1. No API key needed.",
        )
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:11434/v1")
            .setValue(this.plugin.settings.localBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.localBaseUrl = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Local LLM model")
        .setDesc("Local backend: model name sent to the local server, e.g. llama3.1.")
        .addText((text) =>
          text
            .setPlaceholder("llama3.1")
            .setValue(this.plugin.settings.localModel)
            .onChange(async (value) => {
              this.plugin.settings.localModel = value.trim() || "llama3.1";
              await this.plugin.saveSettings();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("CLI command")
        .setDesc(
          "CLI backend: command that reads a prompt on stdin and prints the " +
            "answer, e.g. `claude -p` or `codex exec`. Uses the CLI's own " +
            "login — no API key is stored by the plugin.",
        )
        .addText((text) =>
          text
            .setPlaceholder("claude -p")
            .setValue(this.plugin.settings.cliCommand)
            .onChange(async (value) => {
              this.plugin.settings.cliCommand = value.trim() || "claude -p";
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Default tags")
      .setDesc(
        "Comma-separated tags added to every new transcription note.",
      )
      .addText((text) =>
        text
          .setPlaceholder("meeting")
          .setValue(this.plugin.settings.defaultTags.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.defaultTags = value
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Live recording source")
      .setDesc(
        "Pre-selected source for the 'Transcribe live meeting' modal. " +
          "System audio capture is not exposed to Obsidian on most " +
          "platforms: on macOS install a loopback driver (e.g. BlackHole) " +
          "and select it as the input device; on Windows use Stereo Mix / " +
          "VB-CABLE or screen-share audio; on Linux select a " +
          "PulseAudio/PipeWire monitor source. The plugin will never " +
          "silently fall back to the microphone.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("microphone", "Microphone")
          .addOption("system", "System audio")
          .setValue(this.plugin.settings.liveAudioSource)
          .onChange(async (value) => {
            this.plugin.settings.liveAudioSource = value as LiveAudioSource;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Live chunk length (seconds)")
      .setDesc(
        "How often live audio is transcribed and appended to the note " +
          "(5–60, default 15).",
      )
      .addText((text) =>
        text
          .setPlaceholder("15")
          .setValue(String(this.plugin.settings.liveChunkSeconds))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            const clamped = Number.isFinite(parsed)
              ? Math.min(60, Math.max(5, parsed))
              : 15;
            this.plugin.settings.liveChunkSeconds = clamped;
            await this.plugin.saveSettings();
          }),
      );
  }
}

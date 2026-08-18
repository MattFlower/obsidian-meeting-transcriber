import { App, PluginSettingTab, Setting } from "obsidian";
import type MeetingTranscriberPlugin from "./main";
import type { LiveAudioSource } from "./live";

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
      .setName("LLM base URL")
      .setDesc(
        "OpenAI-compatible API base URL, e.g. https://api.openai.com/v1 " +
          "(also works with Ollama or LM Studio).",
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
      .setName("LLM API key")
      .setDesc("Used as a Bearer token. Leave empty for local servers.")
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
      .setName("LLM model")
      .setDesc("Model name sent to the endpoint, e.g. gpt-4o-mini.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value.trim() || "gpt-4o-mini";
            await this.plugin.saveSettings();
          }),
      );

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

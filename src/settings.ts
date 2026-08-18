import { App, PluginSettingTab, Setting } from "obsidian";
import type MeetingTranscriberPlugin from "./main";

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
}

export const DEFAULT_SETTINGS: TranscriberSettings = {
  modelDir: "models/parakeet",
  outputFolder: "Meetings",
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  defaultTags: ["meeting"],
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
  }
}

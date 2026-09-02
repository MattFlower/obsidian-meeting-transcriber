import { App, PluginSettingTab, Setting } from "obsidian";
import type MeetingTranscriberPlugin from "./main";
import type { LiveAudioSource } from "./live";
import {
  NORMALIZER_STRUCTURES,
  NORMALIZER_STYLINGS,
  type NormalizerStructure,
  type NormalizerStyling,
} from "./normalize";

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
  /** Master switch for transcript normalization with S1-mini by Superwhisper. */
  normalizerEnabled: boolean;
  /** Base URL of the local OpenAI-compatible server running S1-mini. */
  normalizerBaseUrl: string;
  /** Optional Bearer token for that server. */
  normalizerApiKey: string;
  /** Model name the server knows S1-mini by. */
  normalizerModel: string;
  /** S1-mini control line: register of the output. */
  normalizerStyling: NormalizerStyling;
  /** S1-mini control line: whether Markdown bullets are allowed. */
  normalizerStructure: NormalizerStructure;
  /** Normalize notes created by the file transcription command. */
  normalizeFileTranscripts: boolean;
  /** Normalize a live recording's note once the session stops. */
  normalizeLiveOnStop: boolean;
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
  normalizerEnabled: false,
  normalizerBaseUrl: "http://localhost:11434/v1",
  normalizerApiKey: "",
  normalizerModel: "s1-mini",
  normalizerStyling: "semi-formal",
  normalizerStructure: "prose",
  normalizeFileTranscripts: true,
  normalizeLiveOnStop: true,
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
            "answer, e.g. `claude -p` or `codex exec`. Common install " +
            "locations (Homebrew, /usr/local/bin, ~/.local/bin, npm global) " +
            "are searched even though Obsidian does not inherit your " +
            "shell's PATH; if the command is still not found, give an " +
            "absolute path and quote it if it contains spaces. Uses the " +
            "CLI's own login — no API key is stored by the plugin.",
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

    new Setting(containerEl)
      .setName("Normalize transcripts with S1-mini by Superwhisper")
      .setDesc(
        "Rewrite raw transcripts as clean written text (fillers removed, " +
          "self-corrections resolved, punctuation and capitalization " +
          "applied, numbers and dates written out) with the S1-mini text " +
          "normalizer, served by a local OpenAI-compatible server such as " +
          "Ollama, llama-server or LM Studio. English only. The raw " +
          "transcript in the note is replaced. See the README for server " +
          "setup.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.normalizerEnabled)
          .onChange(async (value) => {
            this.plugin.settings.normalizerEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.normalizerEnabled) {
      new Setting(containerEl)
        .setName("S1-mini server URL")
        .setDesc(
          "OpenAI-compatible base URL of the server running S1-mini: " +
            "Ollama http://localhost:11434/v1, llama-server " +
            "http://localhost:8080/v1, LM Studio http://localhost:1234/v1.",
        )
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:11434/v1")
            .setValue(this.plugin.settings.normalizerBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.normalizerBaseUrl =
                value.trim() || "http://localhost:11434/v1";
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("S1-mini API key")
        .setDesc("Optional Bearer token; leave empty for local servers.")
        .addText((text) =>
          text
            .setPlaceholder("(none)")
            .setValue(this.plugin.settings.normalizerApiKey)
            .onChange(async (value) => {
              this.plugin.settings.normalizerApiKey = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("S1-mini model name")
        .setDesc(
          "The name the server knows the model by: s1-mini when created " +
            "from the Ollama Modelfile, any name for llama-server, the " +
            "loaded model's identifier in LM Studio.",
        )
        .addText((text) =>
          text
            .setPlaceholder("s1-mini")
            .setValue(this.plugin.settings.normalizerModel)
            .onChange(async (value) => {
              this.plugin.settings.normalizerModel = value.trim() || "s1-mini";
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("S1-mini styling")
        .setDesc(
          "Register of the output: casual (all lowercase), semi-casual " +
            "(speaker's phrasing kept), semi-formal (standard written " +
            "English, contractions kept), formal (contractions expanded).",
        )
        .addDropdown((dropdown) => {
          for (const styling of NORMALIZER_STYLINGS) {
            dropdown.addOption(
              styling,
              styling === "semi-formal" ? "semi-formal (default)" : styling,
            );
          }
          dropdown
            .setValue(this.plugin.settings.normalizerStyling)
            .onChange(async (value) => {
              this.plugin.settings.normalizerStyling =
                value as NormalizerStyling;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("S1-mini structure")
        .setDesc(
          "prose keeps everything in sentences; lists lets the model turn " +
            "a clear enumeration of three or more items into Markdown " +
            "bullets.",
        )
        .addDropdown((dropdown) => {
          for (const structure of NORMALIZER_STRUCTURES) {
            dropdown.addOption(
              structure,
              structure === "prose" ? "prose (default)" : structure,
            );
          }
          dropdown
            .setValue(this.plugin.settings.normalizerStructure)
            .onChange(async (value) => {
              this.plugin.settings.normalizerStructure =
                value as NormalizerStructure;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Normalize transcribed audio files")
        .setDesc(
          "Run S1-mini on each note created by 'Transcribe meeting audio " +
            "to note' right after it is written. If the server cannot be " +
            "reached, the raw transcript is kept.",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.normalizeFileTranscripts)
            .onChange(async (value) => {
              this.plugin.settings.normalizeFileTranscripts = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Normalize live recordings when they stop")
        .setDesc(
          "Run S1-mini once over the whole transcript after a live " +
            "recording session ends. Chunks are never normalized " +
            "individually while recording.",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.normalizeLiveOnStop)
            .onChange(async (value) => {
              this.plugin.settings.normalizeLiveOnStop = value;
              await this.plugin.saveSettings();
            }),
        );
    }
  }
}

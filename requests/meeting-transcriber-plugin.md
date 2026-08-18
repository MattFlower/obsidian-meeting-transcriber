Build an Obsidian plugin that uses AI to transcribe meetings inside of Obsidian,
using Parakeet to make the meeting transcription. Add an option to summarize the
transcription — setting tags and describing it so it can be more easily
searchable in the future.

Where: repo root, greenfield for the plugin — there is no package.json,
manifest.json, or TypeScript in this repo yet.

Done means: `npm run build` produces the plugin bundle and `npm test` passes; the
plugin loads in an Obsidian vault; a command transcribes a meeting audio file
from the vault into a note using Parakeet; and a separate summarize option adds
tags and a description to that note.

Out of scope: live or real-time recording (the input is an audio file already in
the vault), speaker diarization, cloud transcription services, submitting to the
Obsidian community plugin registry, and the existing Rust crate (Cargo.toml,
src/main.rs) — leave it in place and unused. Do not modify adws/ or .claude/.

Implement the plan in specs/0c5d1b5b_summarizer-backends.md: a summarization
backend the user selects in plugin settings, with three choices —

  - a cloud LLM over its HTTP API, with the user's API key entered in settings
  - a local LLM running on the user's machine
  - a local CLI invoked as a subprocess — `claude -p` or the OpenAI equivalent —
    using the CLI's own already-configured auth, so the plugin stores no key

The summary is written into the meeting note as a `## Summary` markdown heading
section at the top of the note body, above the transcript.

Where: the files named in the plan.
Done means: with a backend configured, a user can summarize a transcribed
meeting and see a `## Summary` section as the first section of the note body,
above the transcript; changing the backend in settings changes which one runs;
the existing default behaviour still works for a user who changes no settings;
tests cover the summary landing at the top of the note.
Out of scope: changing the transcription pipeline itself, summarizing notes that
are not meeting notes, automatic re-summarization on transcript updates, and any
UI beyond triggering the summary and choosing the backend.

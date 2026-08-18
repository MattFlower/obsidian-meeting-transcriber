# Live recording panel

## What changed

Live recording controls now live in a dockable Obsidian sidebar panel instead of a modal. The panel opens in the right workspace area, can remain visible beside the note, and is registered as **Live meeting transcription**. This lets the recording note stay readable and editable while transcription continues.

Open it with the command **Transcribe live meeting (record audio)**, or click the microphone ribbon icon (**Transcribe live meeting**). If the panel is already open, either entry reveals the existing panel rather than creating another one.

## Panel contents

The panel contains:

- **Audio source**, with Microphone and System audio choices.
- **Input device**, including System default and the available audio inputs.
- The existing system-audio guidance below the device selector.
- **Start recording** / **Stop recording** and **Pause** / **Resume** controls.
- A live status readout and the destination note path.

The status readout shows **Idle** when stopped, **● Recording 00:00** while recording, **⏸ Paused 00:00** while paused, and **Transcribing chunk… 00:00** while a chunk is being processed. The clock is the elapsed session time. Once a recording note exists, the panel also shows `Writing to: <note path>`.

The note is created and updated as before, but it is no longer hidden behind the recording UI: leave it open in the main workspace to read incoming transcript text or edit the note while the panel remains docked.

## What this means for modal users

There is no separate modal to reopen or close. Use the command or ribbon microphone to reveal the sidebar panel, then dock or resize it as desired. Closing the panel while recording still ends the session after its final transcription work; reopening the panel reveals the registered view.

The plugin now requires **Obsidian 1.7.2 or newer**. The minimum was raised from 1.4.0 because the new implementation uses Obsidian's registered `ItemView` and workspace-leaf APIs to create, reveal, and dock the panel.

## Where to verify

- `src/live-panel.ts` implements the dockable view, its selectors, controls, status readout, note destination, and recording lifecycle.
- `src/main.ts` registers the view and wires the command and microphone ribbon icon to open or reveal it; unloading detaches the view.
- `manifest.json` declares the raised `minAppVersion` of `1.7.2`.

To verify the change, run the live-recording command or click the microphone ribbon icon, confirm the panel appears in the right sidebar, and start a session with the note visible in the main workspace. Confirm that the panel status and `Writing to:` path update while the note remains available for reading and editing.

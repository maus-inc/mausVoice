---
title: "Settings map"
description: "Locate every configuration area in the current desktop app."
sidebar:
  order: 1
---

Open **Settings** from the bottom of the left navigation rail. Every control on the page saves as you change it, so there is no separate Save or Close action. The page has a search field at the top that matches setting names, section names, and common synonyms.

A rail on the left lists the eight sections and follows you as you scroll. Selecting one jumps to it, so you can reach Advanced without reading everything above it.

The sections appear in this order:

1. General
2. Dictation
3. AI and processing
4. Pill and appearance
5. Shortcuts
6. Privacy and data
7. Updates
8. Advanced

Two sections carry a nested subsection: **Danger zone** sits inside Privacy and data, and **Input permissions** sits inside Advanced.

## General

- **Start on system startup** toggles operating-system auto-launch.
- **Microphone** selects a capture device.
- **Audio** controls the start and stop interaction chime and the system-playback dim level during recording.
- **Diagnostics** shows platform paths and exports a support bundle.

## Dictation

- **Text insertion options** chooses paste or simulated typing globally and per detected application.
- **Dictation language** chooses the primary recognition language. Additional-language shortcuts are managed in the language dialog.
- **Dictation limit (minutes)** caps one recording, where `0` means no timer. The row shows for the current Local and API transcription modes.
- **Hands-free output delay (ms)** sets how long the app waits before delivering hands-free output.
- **Spoken commands** toggles hands-free formatting commands such as new line and punctuation. They are on by default.
- **Real-time output** inserts committed speech segments while you are still recording. See [Real-time output](../using-mausvoice/real-time-output/) for the full set of conditions.
- **Review before insert** opens the pill's editable panel after processing and before insertion. See [Text insertion options](../using-mausvoice/text-insertion/).
- **Silence hallucination filter** drops confident output whose own audio is silent.
- **Switch style while dictating** enables cycling styles with the arrow keys mid-recording.

## AI and processing

- **Deepgram API key** and **Groq API key** are quick credential forms for fast streaming transcription and generative post-processing respectively.
- **AI transcription** chooses Local or API processing, the local model and device, or a task-compatible provider record. Gladia records expose `solaria-1` and support live plus batch and import transcription.
- **AI post processing** chooses API or Off and a generative provider record.
- **Assistant mode** is the command and chat workflow, with a separate provider, shortcut, feature switch, and optional power mode.
- **Automatic style loading** loads the style assigned to the app that was focused when dictation began, in Manual styling mode.
- **Styling mode** selects **Based on app** or **Manual**.

A credential can appear for more than one task only when its provider supports that task, so selecting a transcription key does not also select it for post-processing or Assistant mode.

## Pill and appearance

- **Show menu bar icon** controls the tray or menu-bar icon. Keep another reliable way to open the app before hiding it.
- **Dictation pill visibility** chooses **Persistent**, **While active**, or **Hidden**.
- **Pill placement** anchors the dictation pill to the top or bottom of the screen and defaults to bottom. Windows only for now; the setting is hidden on macOS and Linux until their native pills support repositioning.
- **Reset pill position** chooses which display the tray's reset action returns to: **Current monitor**, the one holding the pill, or **Monitor under cursor**, the one holding the pointer. It does not move the pill immediately.
- **Streak celebrations** controls the flame and firework animation in the pill. It does not change stored transcription content.

## Shortcuts

- **Hotkey shortcuts** configures the hold-to-dictate, cancel, open chat, add-to-dictionary, Assistant, and manual-style actions. Conditional actions appear only when their feature is active.
- **Style hotkeys** binds direct keys to individual writing styles.

## Privacy and data

- **Where your dictation audio goes** discloses which audio reaches which cloud provider.
- **Incognito mode** prevents new history rows and managed audio snapshots. **Include incognito in stats** appears while it is on.
- **Preserve audio on failure** keeps the recording when transcription fails.
- **ElevenLabs keyterms** controls whether your glossary is sent to ElevenLabs as keyterms, which affects billing.
- **Auto-learn dictionary** adds words from History corrections to your glossary automatically.
- **Learn from corrections** watches the target app after a dictation lands and offers a correction you can accept or ignore.
- **Multi-device** opens the receiver, pairing, and routing controls. Microphone audio is never routed to the receiver.
- **Danger zone** contains **Clear local data**. It clears eleven SQLite tables but is not a full uninstall or filesystem wipe, so read the confirmation dialog and the [clear-local-data guide](./clear-local-data/) first.

## Updates

- **Automatically show updates** controls whether the update window opens when a newer version is detected.
- **Software update** shows the running version, when the app last checked, and a **Check now** button.
- **Update channel** chooses **Stable** or **Beta**. A beta client receives prereleases on the beta channel until you switch back. See [Software updates](../getting-started/updates/).

## Advanced

- **Input permissions** runs a platform-specific helper: uinput or udev setup on Linux, administrator-assisted input capture on Windows, and Accessibility plus Microphone requests on macOS.
- **Configure input permissions** re-runs that helper and then restarts the app.
- **Always run as administrator** on Windows makes the app ask for elevation at the next launch. If you decline, a dialog offers to continue without elevation or to close the app.
- **Terms & conditions** opens the repository's AGPL license.

Conditional rows are omitted when their prerequisites are inactive, so if a control described here is absent, confirm the active transcription and styling modes before treating that as an installation fault.
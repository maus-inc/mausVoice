---
title: "Settings map"
description: "Locate every configuration area in the current desktop app."
sidebar:
  order: 1
---

Open **Settings** from the bottom of the left navigation rail. Most controls save as you change them. The exceptions are the API key forms for Deepgram and Groq, which open a dialog with explicit **Save** and **Cancel** buttons. The settings surface has a search field at the top that matches setting names, section names, and common synonyms, and every match jumps straight to its row.

A rail on the left lists the seven sections and stays put while you read a page. Each section is its own page, so a long list never buries the section you want next:

1. Dictation
2. AI and models
3. Shortcuts
4. Appearance
5. Privacy and data
6. System
7. Account

Two sections carry a nested subsection: **Input permissions** sits inside System, and **Danger zone** sits inside Account.

## Dictation

- **Microphone** selects a capture device and tests it.
- **Audio** controls the start and stop interaction chime and the system-playback dim level during recording.
- **Dictation language** chooses the primary recognition language. Additional-language shortcuts are managed in the language dialog.
- **Multiple languages** gives each configured language its own hotkey.
- **Spoken commands** toggles hands-free formatting commands such as new line and punctuation. They are on by default.
- **Silence hallucination filter** drops confident output whose own audio is silent.
- **Switch style while dictating** enables cycling styles with the arrow keys mid-recording.
- **Text insertion options** chooses paste or simulated typing globally and per detected application.
- **Real-time output** inserts committed speech segments while you are still recording. See [Real-time output](../using-mausvoice/real-time-output/) for the full set of conditions.
- **Review before insert** opens the pill's editable panel after processing and before insertion. See [Text insertion options](../using-mausvoice/text-insertion/).
- **Dictation limit (minutes)** caps one recording, where `0` means no timer. The row shows for the current Local and API transcription modes.
- **Hands-free output delay (seconds)** sets how long the app waits after you stop speaking before delivering hands-free output.

## AI and models

- **Deepgram API key** and **Groq API key** are quick credential forms for fast streaming transcription and generative post-processing respectively.
- **AI transcription** chooses Local or API processing, the local model and device, or a task-compatible provider record. Gladia records expose `solaria-1` and support live plus batch and import transcription.
- **AI post processing** chooses API or Off and a generative provider record.
- **Assistant mode** is the command and chat workflow, with a separate provider, shortcut, feature switch, and optional power mode.
- **Styling mode** selects **Based on app** or **Manual**.
- **Automatic style loading** loads the style assigned to the app that was focused when dictation began, in Manual styling mode.

A credential can appear for more than one task only when its provider supports that task, so selecting a transcription key does not also select it for post-processing or Assistant mode.

## Shortcuts

- **Hotkey shortcuts** configures the hold-to-dictate, cancel, open chat, add-to-dictionary, Assistant, and manual-style actions. Conditional actions appear only when their feature is active.
- **Style hotkeys** binds direct keys to individual writing styles.

## Appearance

- **Dictation pill visibility** chooses **Persistent**, **While active**, or **Hidden**.
- **Pill placement** anchors the dictation pill to the top or bottom of the screen and defaults to bottom. Windows only for now; the setting is hidden on macOS and Linux until their native pills support repositioning.
- **Reset pill position** chooses which display the tray's reset action returns to. **Current monitor** is the one holding the pill, and **Cursor monitor** is the one holding the pointer. It does not move the pill immediately.
- **Show menu bar icon** controls the tray or menu-bar icon. Keep another reliable way to open the app before hiding it.
- **Streak celebrations** controls the flame and firework animation in the pill. It does not change stored transcription content.

## Privacy and data

- **Where your dictation audio goes** discloses which audio reaches which cloud provider.
- **ElevenLabs keyterms** controls whether your glossary is sent to ElevenLabs as keyterms, which affects billing.
- **Incognito mode** prevents new history rows and managed audio snapshots. **Include incognito in stats** appears while it is on.
- **Preserve audio on failure** keeps the recording when transcription fails.
- **Auto-learn dictionary** adds words from History corrections to your glossary automatically.
- **Learn from corrections** watches the target app after a dictation lands and offers a correction you can accept or ignore.
- **Multi-device** opens the receiver, pairing, and routing controls. Microphone audio is never routed to the receiver.

## System

- **Start on system startup** toggles operating-system auto-launch.
- **Always run as administrator** on Windows makes the app ask for elevation at the next launch. If you decline, a dialog offers to continue without elevation or to close the app.
- **Input permissions** runs a platform-specific helper: uinput or udev setup on Linux, administrator-assisted input capture on Windows, and Accessibility plus Microphone requests on macOS.
- **Configure input permissions** re-runs that helper and then restarts the app for you.
- **Diagnostics** shows platform paths and exports a support bundle.
- **Automatically show updates** controls whether the update window opens when a newer version is detected.
- **Software update** shows the running version, when the app last checked, and a **Check now** button.
- **Update channel** chooses **Stable** or **Beta**. A beta client receives prereleases on the beta channel until you switch back. See [Software updates](../getting-started/updates/).
- **Terms & conditions** opens the repository's AGPL license.

## Account

- **Name** opens the profile dialog, which is where the picture and the name are edited together. A well at the top of the dialog holds the current picture with a camera badge, the format note (PNG, JPG, or WebP, up to 5 MB, cropped to a square), and the **Change photo** and **Remove photo** actions; **Remove photo** appears only once a picture exists. The name field, **Cancel**, and **Save** sit below, and Enter saves. Until a picture is set, the app shows your initials in place of one. The picture is stored on this computer only; the name is what mausVoice uses when it writes on your behalf.
- **Signed in as** names the account this copy of mausVoice is using.
- **Plan** describes what the current plan includes. Change it from the mausVoice website.
- **Change password** sends a password reset link to the signed-in address.
- **Sign out** ends this session on this computer. Your data stays where it is.
- **Danger zone** holds the two destructive rows, **Clear local data** and **Delete account**, each naming its action (**Clear data**, **Delete**). Clearing local data empties eleven SQLite tables and the app's own stored state on this computer, including the profile picture, but it is not a full uninstall or filesystem wipe. Read the confirmation dialog and the [clear-local-data guide](./clear-local-data/) before using it. **Delete account** needs a connection and appears only while an account is signed in. Both confirmations list what the action removes before asking you to type the confirmation word, and their destructive buttons are red rather than the neutral primary fill.

Conditional rows are omitted when their prerequisites are inactive, so if a control described here is absent, confirm the active transcription and styling modes before treating that as an installation fault.

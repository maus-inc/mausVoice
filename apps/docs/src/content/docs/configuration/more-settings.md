---
title: "More settings"
description: "Configure privacy, updates, tray behavior, pill behavior, styles, limits, and real-time output."
sidebar:
  order: 8
---

Open **Settings → General → More settings** for controls that do not belong to one provider or device. Changes are saved as you make them; **Close** dismisses the dialog rather than acting as a separate Save button.

## Privacy and app behavior

- **Incognito mode** prevents new transcription-history rows and managed audio snapshots. It does not turn off API processing or erase existing history. **Include incognito in stats** appears while Incognito is on and separately controls whether those dictated words contribute to usage statistics.
- **Automatically show updates** controls whether the update window opens when a newer version is detected. It does not change the release source or install an update silently.
- **Show menu bar icon** controls the tray/menu-bar icon. Keep another reliable way to open the app before hiding it.
- **Streak celebrations** controls flame and firework animation in the pill; it does not change stored transcription content.

## Pill controls

**Dictation pill visibility** has three values:

- **Persistent** keeps the idle indicator available.
- **While active** shows it for recording and processing activity.
- **Hidden** suppresses normal idle visibility. Starting a task can still reveal the pill for activity.

**Reset pill position** decides which display is used when you invoke the tray's reset action: the monitor containing the pill or the monitor containing the pointer. It does not immediately reset the position.

**Pill placement** anchors the dictation pill to the **top** or **bottom** of the screen. It defaults to bottom; choose top if the bottom anchor is obscured by another app or a taskbar. The preference is remembered across sessions. Windows only for now; the setting is hidden on macOS and Linux until their native pills support repositioning.

## Text handling

- **Spoken commands** turns deterministic formatting commands ("new line", "comma", "scratch that") on or off. Commands apply when the dictation language is English or Auto. Enabled by default. See [Spoken formatting commands](../../using-mausvoice/spoken-commands/) for the full command list.
- **Real-time output** inserts committed text segments while recording rather than waiting for the whole result. In the current build it requires Manual styling with Verbatim selected and a session that emits committed segments: AssemblyAI, Deepgram, ElevenLabs, or Gladia. Assigning Verbatim in Based on app mode does not activate it. Local, batch, and current Azure sessions still deliver in bulk. Because text is inserted incrementally, canceling cannot retract segments already delivered. Replacement and symbol rules are applied to each segment, but generative style post-processing is not. See [Real-time output](../../using-mausvoice/real-time-output/) for the complete behavior.
- **Review before insert** opens an editable composer after transcription and cleanup, before text is inserted. You can edit the result, then confirm or cancel.
- **Silence hallucination filter** discards common fabricated phrases produced when the microphone hears silence or noise. Enabled by default.
- **Switch style while dictating** lets you hold the dictate activation key and press Left or Right Arrow to cycle active styles. Requires Manual styling mode.

## Styling and limits

- **Styling mode** selects **Based on app** or **Manual**. In manual mode, **Automatic style loading** can load the style assigned to the app that was focused when dictation began.
- **Dictation limit** defaults to five minutes. The app warns one minute before a limit longer than one minute and stops recording at the limit. Enter `0` for no timer. Negative or nonnumeric input is rejected; fractional values are floored and excessively large values are capped. The row is shown for the current Local and API transcription modes.

## Multi-device

- **Multi-device** opens receiver, pairing, and routing controls. With real-time output active, committed text segments can be routed to the receiver; microphone audio itself is never sent by this feature.

Conditional rows are omitted when their prerequisites are inactive. If a control described here is absent, confirm the active transcription and styling modes before treating that as an installation fault.

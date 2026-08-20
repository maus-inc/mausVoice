---
title: "Keyboard shortcuts"
description: "Configure global dictation, cancellation, Assistant, chat, dictionary, language, and style actions."
sidebar:
  order: 5
---

Open **Settings → General → Hotkey shortcuts**. Click a key box, press the complete combination, then release it. Changes are written immediately; closing the dialog is not a separate save step. Pressing `Escape` before entering a combination leaves key capture.

## Available actions

- **Hold to dictate** records while held and stops for processing on release.
- **Assistant mode** appears only while the beta Assistant feature is enabled. It sends the recording through the command workflow rather than ordinary dictation.
- **Cancel transcription** cancels the current dictation or Assistant session.
- **Open chat** opens the current Assistant conversation in the main window.
- **Add to dictionary** reads the text selected in the active application and creates a dictionary entry.
- **Next writing style** and **Previous writing style** appear in manual styling mode and cycle active styles during a recording.
- Additional dictation-language hold actions are configured under **Dictation language**, not in this dialog.

Use **Add another** to assign more than one combination to the same action. The overlap warning means one combination equals or is a subset of another configured action, so a press may trigger both. Resolve the conflict; event order is not something to rely on.

## Defaults and reset behavior

| Action                 | macOS       | Windows                          |
| ---------------------- | ----------- | -------------------------------- |
| Hold to dictate        | `Fn`        | Left Windows/Meta + Left Control |
| Cancel current session | `Escape`    | `Escape`                         |
| Previous manual style  | Left Arrow  | Left Arrow                       |
| Next manual style      | Right Arrow | Right Arrow                      |

The other actions have no built-in combination. A reset-arrow beside a changed built-in action restores its platform default. If no explicit nonempty binding exists for one of those four actions, the app resolves it to the built-in default; clearing a key box is therefore not a reliable way to disable a built-in action.

Style and cancel shortcuts are active only in the relevant recording state, reducing interference with normal arrow and Escape use. Cancellation stops further work, but [real-time output](../real-time-output/) cannot retract segments that have already reached the target.

## Platform notes

Choose combinations not consumed by keyboard firmware, the operating system, a window manager, an accessibility utility, or the target application. Compact keyboards may handle `Fn` entirely in firmware. Test from a plain text editor with mausVoice in the background.

On Linux systems using compositor bridging, a shortcut must include a non-modifier key such as a letter or number. After recording one, mausVoice warns that the compositor may need reloading. Sway must include `~/.config/sway/mausvoice-hotkeys`; Hyprland must source `~/.config/hypr/mausvoice-hotkeys.conf`. GNOME, KDE, and COSMIC use compositor-specific registration paths managed by the native integration. A combination shown in Settings proves it was saved, not that the compositor accepted it.

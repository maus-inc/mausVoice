---
title: "Default shortcuts"
description: "Reference platform defaults, hold versus release semantics, custom actions, and Linux behavior."
sidebar:
  order: 2
---

| Action                 | macOS       | Windows                          |
| ---------------------- | ----------- | -------------------------------- |
| Hold to dictate        | `Fn`        | Left Windows/Meta + Left Control |
| Cancel current session | `Escape`    | `Escape`                         |
| Previous manual style  | Left Arrow  | Left Arrow                       |
| Next manual style      | Right Arrow | Right Arrow                      |

Dictation is a hold action: pressing starts capture and releasing stops it. Assistant dictation and additional-language shortcuts use the same hold model when configured. Cancel/style actions fire on release and become relevant only during an active session; style cycling additionally requires **Manual styling**.

Assistant, Open chat, Add to dictionary, and additional languages have no built-in key combination. Configure the applicable action in **Settings → General → Hotkey shortcuts**, **Settings → Processing → Assistant mode**, or **Settings → Processing → Dictation language**. The editor supports multiple saved combinations per action; once a custom dictation binding exists, it takes precedence over the platform default. The reset button restores a known default only for actions listed in the table.

Linux has no universal default in the desktop platform table. On Wayland, mausVoice can synchronize hold/fire actions with supported compositor bindings, but the compositor and user configuration determine the effective global combination. Open chat is not in the current static compositor-trigger list.

Physical side matters for the Windows default: source records `MetaLeft` plus `ControlLeft`. Keyboard remappers, accessibility tools, virtual machines, remote-desktop software, firmware layers, and target applications can reserve a combination even when it saves successfully. If press/release behavior sticks, first test a plain non-modifier combination, then inspect the [hotkey troubleshooting guide](../../troubleshooting/hotkeys/).

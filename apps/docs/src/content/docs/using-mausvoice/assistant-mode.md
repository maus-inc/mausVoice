---
title: "Assistant mode"
description: "Configure the experimental voice assistant, understand its tools, and use power mode safely."
sidebar:
  order: 10
---

Assistant mode is an experimental command workflow, separate from ordinary dictation. Instead of cleaning up a transcript and inserting it directly, mausVoice sends the recognized command into an assistant conversation. The assistant can answer, inspect the focused interface through accessibility APIs, and request permission to paste text. When power mode is enabled, it can also request permission to run a shell command.

## Configure it

1. Open **Settings → AI and processing → Assistant mode**.
2. Choose **API** and select or add a credential whose provider supports generative text. **Off** leaves the assistant without an LLM backend.
3. Configure the **Assistant hotkey**.
4. Turn on the separate **Assistant mode** switch. This feature is disabled by default.

The assistant has its own provider selection. Changing the transcription provider or the ordinary post-processing provider does not change the assistant's LLM setting. Requests, conversation context, accessibility results, and tool results needed by the conversation can be sent to the selected provider; review that provider's retention terms before using sensitive material.

## Dictate a command

Hold the configured assistant shortcut, speak an instruction, and release it. The voice is transcribed using the active transcription configuration, but the recognized text becomes a chat message rather than a normal history row. The assistant conversation appears in the pill and under **Chats** in the main navigation.

Useful companion shortcuts are listed under **Settings → Shortcuts → Hotkey shortcuts**:

- **Open chat** opens the current assistant conversation in the main window.
- **Cancel transcription** cancels the active dictation or assistant session.

The assistant can iterate through several model and tool steps. Watch the activity and permission prompts; a request is not necessarily finished after the first response.

## Tool approvals

The built-in tool set can read the focused field and surrounding screen context, paste into the focused field, and close the pill conversation. Every permissioned request presents **Deny**, **Allow**, and **Always allow** choices. Inspect the stated reason and parameters before approving it.

**Always allow** is broader than a one-time approval: it is remembered in the app's webview local storage by tool, not by an individual command. The danger-zone database reset does not clear that browser storage. For sensitive tools, prefer **Allow** so each use remains visible.

## Power mode

Power mode adds the `run_terminal_command` tool. The Rust backend validates each command against `ALLOWED_COMMANDS` (Unix: `ls`, `pwd`, `echo`, `cat`, `which`, `whoami`, `date`, `uname`, `df`, `du`, `head`, `tail`, `wc`, plus `open`/`xdg-open`; Windows: `whoami`, `where`, `hostname`, `explorer`) and executes directly, without a shell (`sh -c` / `cmd /C`). Shell metacharacters such as `/`, `\`, `;`, `|`, `&`, and `$` are rejected anywhere in an argument, and a bare `..` argument is refused. Absolute paths and paths into subdirectories or parent directories are not allowed. Commands may use bare names in their default working directory and other non-path arguments, but cannot be directed to an arbitrary location. Commands run with the mausVoice process's full user permissions.

Enabling power mode requires a warning confirmation, and the dialog asks you to restart mausVoice before relying on the change. Keep it off unless the task genuinely needs shell access. Never approve a command you do not understand, and avoid **Always allow** for terminal execution. Turning the switch off and restarting removes the terminal tool from the assistant, but previously remembered always-allow storage is a separate setting.

For ordinary drafting and rewriting, leave power mode disabled. Screen-context and paste tools are enough for most field-focused work, and without shell access a mistaken or malicious instruction can do far less damage.

## Computer use

Computer use lets the assistant look at your screen and act on it, rather than only reading the focused field. It works with any model provider that offers computer use. When the selected provider does not, the app says so and names that provider instead of failing quietly.

Turn it on under the Computer use switch in assistant mode settings. The first time you switch it on, a warning explains that the assistant can read the screen and move your mouse and keyboard. The setting does not carry across restarts, so computer use is off again the next time you open the app unless you turn it on once more. Power mode and computer use are separate switches, and accepting one is not accepting the other.

How a task runs:

1. The assistant captures a screenshot of the display your cursor is on.
2. The model reads it and picks one action.
3. The app asks you, when that action needs approval.
4. The action runs, and a new screenshot shows the outcome.
5. Steps 2 to 4 repeat until the model reports it is finished, until you press stop, or until the assistant notices it is going in circles.

Screenshots are resized to 1280 pixels wide and compressed before they leave your machine.

Computer use commands work only in the main window. The pill and floating windows cannot read the screen or move the pointer, so a page rendered there cannot drive your computer.

### Risk levels and approvals

Every computer-use action carries a risk level, and the level decides what happens:

| Risk | What happens |
| --- | --- |
| Low | Runs straight away. These actions only read, such as taking a screenshot, checking the pointer position or waiting. |
| Medium | Asks first. Scrolling and moving the pointer fall here. |
| High | Asks first, and the prompt spells out what will happen and names the risk in plain words. Clicking, typing, dragging and key presses are all here. |
| Critical | Warns before it asks, and the prompt offers no way to always allow it. |

Today no computer-use action reaches the critical level, but a tool added later may.

**Always allow** is remembered for that kind of action, not for the whole session. Allowing every click does not hand over your keyboard, and allowing the keyboard does not allow terminal commands.

A model can also refuse an action before it reaches you. A refusal shows as skipped rather than failed, because the difference matters: a failure means something went wrong, and a refusal means you said no.

### Stopping a run

The stop button ends the run. It cancels the request in flight, cancels any action that has not started, and records the outcome. An action already running reports its result before the run closes, so you can see what happened before you stopped it.

### When the assistant gets stuck

If the assistant repeats the same action, or the screen stops changing, the run stops on its own and tells you what it noticed rather than continuing to click.

### Platform support

| Platform | Support |
| --- | --- |
| Linux, X11 | Full |
| Windows | Full |
| macOS | Full |
| Linux, Wayland | Not yet |

On Wayland the app cannot read the screen without a portal service, so computer use is unavailable rather than half-working.

The Windows and macOS capture paths are written against the `windows` and `core-graphics` crate signatures. They are compiled by the Windows-gated CI job and the macOS release build respectively, not by the Linux clippy gate.

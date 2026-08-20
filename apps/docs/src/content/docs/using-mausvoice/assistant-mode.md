---
title: "Assistant mode"
description: "Configure the experimental voice assistant, understand its tools, and use power mode safely."
sidebar:
  order: 10
---

Assistant mode is an experimental command workflow, separate from ordinary dictation. Instead of cleaning up a transcript and inserting it directly, mausVoice sends the recognized command into an assistant conversation. The assistant can answer, inspect the focused interface through accessibility APIs, and request permission to paste text. When power mode is enabled, it can also request permission to run a shell command.

## Configure it

1. Open **Settings → Processing → Assistant mode**.
2. Choose **API** and select or add a credential whose provider supports generative text. **Off** leaves the assistant without an LLM backend.
3. Configure the **Assistant hotkey**.
4. Turn on the separate **Assistant mode** switch. This feature is disabled by default.

The assistant has its own provider selection. Changing the transcription provider or the ordinary post-processing provider does not change the assistant's LLM setting. Requests, conversation context, accessibility results, and tool results needed by the conversation can be sent to the selected provider; review that provider's retention terms before using sensitive material.

## Dictate a command

Hold the configured assistant shortcut, speak an instruction, and release it. The voice is transcribed using the active transcription configuration, but the recognized text becomes a chat message rather than a normal history row. The assistant conversation appears in the pill and under **Chats** in the main navigation.

Useful companion shortcuts are listed under **Settings → General → Hotkey shortcuts**:

- **Open chat** opens the current assistant conversation in the main window.
- **Cancel transcription** cancels the active dictation or assistant session.

The assistant can iterate through several model and tool steps. Watch the activity and permission prompts; a request is not necessarily finished after the first response.

## Tool approvals

The built-in tool set can read the focused field and surrounding screen context, paste into the focused field, and close the pill conversation. Every permissioned request presents **Deny**, **Allow**, and **Always allow** choices. Inspect the stated reason and parameters before approving it.

**Always allow** is broader than a one-time approval: it is remembered in the app's webview local storage by tool, not by an individual command. The danger-zone database reset does not clear that browser storage. For sensitive tools, prefer **Allow** so each use remains visible.

## Power mode

Power mode adds the `run_terminal_command` tool. Commands are strictly validated against a curated allow-list of safe binaries (such as `ls`, `pwd`, `echo`, `which`, `whoami`, `hostname`, `explorer`) and executed directly, without shell expansion (`sh -c` / `cmd /C`). Binary inspection commands like `cat` are excluded from the allow-list. Every supplied argument is also checked: `/`, `\`, and `..` are rejected. Consequently, absolute paths and paths into subdirectories or parent directories are not allowed, even for non-sensitive locations. Commands may use bare names in their default working directory and other non-path arguments, but cannot be directed to an arbitrary location. These limits prevent an allowed reader from being directed to arbitrary files. Commands run with the mausVoice process's full user permissions.

Enabling power mode requires a warning confirmation, and the dialog asks you to restart mausVoice before relying on the change. Keep it off unless the task genuinely needs shell access. Never approve a command you do not understand, and avoid **Always allow** for terminal execution. Turning the switch off and restarting removes the terminal tool from the assistant, but previously remembered always-allow storage is a separate setting.

For ordinary drafting and rewriting, leave power mode disabled. Screen-context and paste tools are enough for most field-focused work, and without shell access a mistaken or malicious instruction can do far less damage.

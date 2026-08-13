---
title: "Uninstall mausVoice"
description: "Remove the application and decide separately whether to erase local data and models."
sidebar:
  order: 10
---

Uninstalling the executable does not necessarily erase the database, model downloads, logs, or saved audio. That separation supports normal upgrades, but it matters when the goal is a complete removal.

## Before uninstalling

If mausVoice still launches, review **History** for text you need. **Settings → Danger zone → Clear local data** clears profile, preference, key, conversation, transcription, dictionary, and hotkey rows after you type `clear`; it is irreversible. It does not remove downloaded models, logs, general storage, the database file itself, or saved audio files, so inspect the platform app-data locations separately.

Remove the app through the platform's normal mechanism:

- **macOS:** remove mausVoice from Applications, or use `brew uninstall --cask mausvoice-desktop` for a Homebrew install.
- **Windows:** uninstall mausVoice from Installed Apps.
- **Linux:** remove the Debian package through the package manager, or delete the AppImage and any launcher you created.

Revoke microphone and input/accessibility permissions if the operating system retains entries for removed applications. On Linux, remove only the compositor keybinding include or udev configuration you added specifically for mausVoice; do not remove shared tools such as `ydotool` if other applications use them.

For a clean reinstall, also remove mausVoice's app config/data/log directories after backing up anything needed. Their exact root is selected by Tauri for the current operating system; the stable children and database names are listed in the Data locations reference.

---
title: Getting started
description: Choose the shortest accurate path from a release download to a reliable first dictation.
sidebar:
  order: 0
---

A working mausVoice setup has four parts: an installed desktop build, operating-system permission to capture audio and global input, a configured transcription route, and a target application that accepts inserted text. Set them up in that order.

## Choose your path

- **macOS:** use the disk image or Homebrew cask, explicitly open the current unsigned build, and grant microphone plus input/accessibility access.
- **Windows:** run the installer, review the unknown-publisher SmartScreen warning for the unsigned build, then complete the app's input-permission setup.
- **Linux:** choose the Debian package or AppImage, identify X11 or Wayland, and configure the input tool and compositor binding required by that session.

Then follow the onboarding walkthrough and make a first dictation in a plain text editor with post-processing Off. That test isolates shortcut capture, microphone access, raw transcription, and insertion before a writing-style provider is introduced.

## Decide where speech is processed

**Local** transcription uses a downloaded model through the bundled Rust sidecar. **API** transcription sends audio to the selected provider or compatible endpoint. Separately, **AI post processing** can be **API** or **Off**. Local transcription with API post-processing is not a wholly offline configuration because transcript text still leaves the app for rewriting.

No account is required for the local and bring-your-own-key desktop path itself. Hosted provider use requires whatever account, key, quota, and network connection that provider specifies.

After the baseline works, configure Styles, Dictionary, language, History privacy, and application-specific insertion one feature at a time. If a stage fails, the troubleshooting checklist follows the same pipeline order.

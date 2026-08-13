---
title: "Dictation languages"
description: "Choose a primary recognition language and add hold shortcuts for multilingual dictation."
sidebar:
  order: 14
---

Open **Settings → Processing → Dictation language**. With one language configured, the row is an ordinary selector; use its three-dot button to open the multi-language dialog. After you add a language, the row shows a **Multiple languages** button instead. Each dialog row has both a language and a hotkey.

## Primary and additional languages

The first row is the primary language and uses the normal hold-to-dictate action. Select **Add language** to create another row, then record a shortcut for it. Holding that additional shortcut starts a normal dictation with that row's language as a recording-only override; releasing it stops the recording. Removing a row also removes its saved hotkey.

Choose non-overlapping combinations. The dialog warns when one configured combination is a subset of another because pressing the longer combination could also trigger the shorter one. Saving replaces the existing set of additional-language hotkeys.

The tray/menu-bar **Language** submenu contains the primary entry, configured additional languages, and **Auto-detect**, with duplicates removed. It stores an active-language preference. For a predictable one-off override in the current build, use the language-specific hold shortcut; it passes the selected language directly into that recording.

## Special choices

- **Auto-detect** asks the transcription path to infer the language. It is convenient for longer speech but less stable on short clips, names, or rapid code-switching.
- **Keyboard layout** resolves the active operating-system keyboard language when recording starts. If that lookup fails, mausVoice logs the failure and falls back to English. New additional rows do not offer this special choice; it can be the primary row.
- Region-specific Chinese and Portuguese choices are normalized to their base language for Whisper-compatible transcription. The Settings warning recommends post-processing for a primary value outside the core Whisper code set.

The selector is built from Whisper's language list plus the special and regional choices. That does **not** guarantee identical support from every cloud provider. Test the actual transcription backend and model you selected, especially for automatic detection, regional variants, and mixed-language speech.

## Interface language is separate

The desktop interface locale is detected from the operating system/browser locale at startup and supports English, Spanish, French, German, Portuguese, Brazilian Portuguese, Italian, Traditional Chinese, Simplified Chinese, and Korean. Choosing a dictation language does not reload the menus into that language.

If recognition chooses the wrong language, inspect the raw History transcript before changing a writing style. Styling runs after speech recognition and cannot reliably reconstruct words the transcription model heard incorrectly.

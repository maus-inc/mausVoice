<div align="center">

<img src="branding/mausvoice-logo-256.png" alt="mausVoice logo" width="88" />

# mausVoice <a href="https://github.com/maus-inc/mausVoice/actions/workflows/test-desktop-unit.yml"><img src="https://img.shields.io/github/actions/workflow/status/maus-inc/mausVoice/test-desktop-unit.yml?branch=main&label=CI&style=flat&color=000000&labelColor=000000" alt="CI" /></a> <a href="https://github.com/maus-inc/mausVoice/releases/latest"><img src="https://img.shields.io/github/v/release/maus-inc/mausVoice?style=flat&labelColor=000000&color=000000" alt="Latest stable release" /></a>

> **Tip:** Grab your free [Groq↗](https://console.groq.com/keys) and [Deepgram↗](https://console.deepgram.com/) API keys.
>
> Transcription accuracy varies by STT provider or model. Transcripts may not be 100 percent accurate because of differences in intonation and native accents. The client-side pipeline is continually optimized.

</div>

<br>

<div align="center">

**Voice typing for your own machine. Dictate into any app and clean it up with AI. No account or subscription needed, and the Rust core keeps CPU and memory usage low.**

[![license: AGPL-3.0](docs/assets/badges/license.svg)](LICENCE)
[![macOS builds available](docs/assets/badges/macos.svg)](https://github.com/maus-inc/mausVoice/releases)
[![Windows builds available](docs/assets/badges/windows.svg)](https://github.com/maus-inc/mausVoice/releases)
[![Linux builds available](docs/assets/badges/linux.svg)](https://github.com/maus-inc/mausVoice/releases)

</div>

## Documentation

**New to mausVoice, tuning a provider, or building from source? Visit the complete [mausVoice Documentation](https://maus-inc.github.io/mausVoice/docs/).** It covers platform setup, daily dictation, every configuration area, provider behavior, privacy and local data, troubleshooting, and the repository architecture.

<p align="center">
  <a href="https://maus-inc.github.io/mausVoice/docs/">
  <img src="docs/assets/readthedocsbtn.png" alt="mausVoice readthedocs button" width="320" />
  </a>
</p>

<p align="center">
  <img src="docs/assets/home-page.png" alt="mausVoice home" width="750" />
</p>

**mausVoice** is a desktop app that turns your voice into text anywhere you can type. Hold a global shortcut, speak, and release. mausVoice transcribes locally or through your chosen provider, optionally applies an **LLM** writing style, and sends the result to the field in focus.

## How it works

1. Press your hotkey and speak. A small overlay shows you're recording.
2. Audio is captured natively and transcribed as it happens, with streaming Deepgram (`nova-3`), or with fully local Whisper if you'd rather keep every byte on-device.
3. An LLM cleans up the transcript. It removes filler, fixes punctuation and formatting, and applies your chosen writing style.
4. The finished text lands in whatever app you're focused on.

<br>

<p align="center">
  <img src="docs/assets/animated-pill.gif" alt="mausVoice pill in action" width="200" />
</p>

## Features

Every stage is configurable. Capture globally, select the transcription path that fits the moment, then control exactly how the finished text reaches the focused app.

### 01 / Global dictation

<a id="global-dictation"></a>

<p><img src="docs/assets/features/dictate-anywhere.png" alt="mausVoice hold-to-dictate overlay with text insertion options for paste, simulated typing, and per-app overrides." width="1280" /></p>

**Your voice, in the field with focus.** Hold a global push-to-talk shortcut and speak into the app you are already using. mausVoice can paste, type directly, or leave the result on your clipboard.

### 02 / Transcription engines

<a id="transcription-engines"></a>

<p><img src="docs/assets/features/choose-your-engine.png" alt="AI transcription settings showing local models (Parakeet, Canary, Whisper) and a Processing device selector with a detected Vulkan GPU." width="1280" /></p>

**Local or hosted. Pick the transcription path.** Run Whisper, Parakeet, or Canary locally on CPU or a detected Vulkan GPU, or choose a hosted provider. Bring your own credentials. Local recognition stays on-device once its model is downloaded.

### 03 / Writing styles

<a id="writing-styles"></a>

<p><img src="docs/assets/features/writing-styles.png" alt="Writing styles list with Professional email, Polished and professional, and Verbatim styles selectable for AI post-processing." width="1280" /></p>

**Say it once. Shape it for the destination.** Create reusable instructions for email, chat, terminal work, or any voice you need. Choose the style before recording, or switch post-processing off for a literal transcript.

### 04 / Dictionary and history

<a id="dictionary-and-history"></a>

<p><img src="docs/assets/features/dictionary-history.png" alt="Dictionary replacement rules and History of past transcriptions with model and device metadata." width="1280" /></p>

**Teach it your vocabulary. Keep the useful trail.** Add replacement rules for names, acronyms, and phrases that general models miss. Review raw and final text, play retained audio, or retranscribe a saved clip with current settings.

### 05 / Assistant

<a id="assistant-approval"></a>

<p><img src="docs/assets/features/assistant-approval.png" alt="Assistant tool approval dialog with Deny, Allow, and Always allow buttons alongside a Power mode toggle." width="1280" /></p>

**Ask for action. Approve every command.** Use voice or text to work with the built-in Assistant and its permissioned tools. Requests pause for Deny, Allow, or Always allow. Power mode keeps shell access off until enabled.

<br>

<p align="center">
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="docs/assets/badges/windows.svg" alt="Download mausVoice for Windows" height="40" />
  </a>
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="docs/assets/badges/macos.svg" alt="Download mausVoice for macOS" height="40" />
  </a>
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="docs/assets/badges/linux.svg" alt="Download mausVoice for Linux" height="40" />
  </a>
</p>

Download links open the releases page, where you'll find the latest `.exe` (Windows), `.dmg` (macOS), and `.AppImage`/`.deb` (Linux) for your platform.

<br>

<div align="center">
  <img src="docs/assets/mausvoice-banner.png" alt="mausVoice" width="840" />
</div>

<br>

<details>
<summary>Developer's quick start</summary>

## Quick start

You'll need macOS, Windows, or Linux, plus Node 20+, pnpm 10, and a Rust toolchain (see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

```bash
pnpm install
```

Then run the desktop app with the platform-specific command:

```bash
cd apps/desktop
pnpm dev:mac        # macOS
pnpm dev:windows    # Windows
pnpm dev:linux      # Linux
```

> `pnpm dev` alone won't work. Native features need the platform-specific command above.

On first launch, the onboarding asks for your transcription and cleanup keys. There are no build-time secrets, and the same binary works for the local Whisper path.

### API keys & configuration

Two optional keys, both entered in Settings:

- **Deepgram** (streaming transcription): [get one here](https://console.deepgram.com/). If you skip it, mausVoice falls back to local Whisper.
- **Groq** (LLM text cleanup): [get one here](https://console.groq.com/keys).

Keys are stored encrypted on your machine and can be changed or rotated any time without rebuilding. For a fully offline setup, leave both empty and point at a downloaded Whisper model.

## Build & quality

From the repo root:

```bash
pnpm run build         # build all workspaces (turborepo)
pnpm run lint          # lint
pnpm run check-types   # TypeScript type checking
pnpm run test          # tests
```

All development documentation is [here](https://maus-inc.github.io/mausVoice/docs/development/repository-overview/).

</details>

## License

[AGPLv3](LICENCE). Built on [Tauri](https://tauri.app), with the frontend in React and the audio/overlay layer in Rust.

**Maintainer:** [Owie Emmanuel](https://github.com/Owie6789)

> **Warning:** mausVoice is currently in very early beta. Although it is not expected during normal use, you may encounter undocumented behavior or bugs carried over from the app's pre-alpha stage.
>
> If you find a bug, please [open an issue](https://github.com/maus-inc/mausVoice/issues/new) and be as detailed as possible. Include the steps to reproduce it, what you expected, what happened, your platform and mausVoice version, and, when possible, a screenshot and sanitized diagnostic logs.
>
> We welcome these reports. They help us, as a community, improve the app for one another. We are grateful for your patience. 😊

<details>
<summary><strong>How to find and attach mausVoice logs</strong></summary>

### Recommended on every platform

1. Open **mausVoice → Settings → General → Diagnostics**.
2. Select **Open** to reveal the log directory, or **Download** to export `mausvoice-diagnostics.zip`.
3. Inspect every file before sharing it. The export is not sanitized by default. Treat the archive as potentially sensitive and remove:
   - names and email addresses,
   - private file paths,
   - transcript fragments,
   - provider responses,
   - API keys, tokens, and other secrets,
   - anything unrelated to the report.
4. Attach the cleaned archive to your GitHub issue with a screenshot and clear reproduction steps.

### macOS

In Finder, choose **Go → Go to Folder…**, then enter:

```text
~/Library/Logs/com.mausinc.desktop
```

### Windows

Press **Win + R**, then enter:

```text
%LOCALAPPDATA%\com.mausinc.desktop\logs
```

### Linux

Open this directory in your file manager:

```text
~/.local/state/com.mausinc.desktop/logs
```

If `XDG_STATE_HOME` is set, use `$XDG_STATE_HOME/com.mausinc.desktop/logs` instead. Production builds use `com.mausinc.desktop` as the identifier. The development Tauri configuration uses `com.mausinc.desktop.dev`, and the local Tauri configuration uses `com.mausinc.desktop.local`. Substitute the matching identifier in the path above.

</details>
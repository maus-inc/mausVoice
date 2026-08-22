<div align="center">

<img src="branding/mausvoice-logo-256.png" alt="mausVoice logo" width="88" />

# mausVoice <a href="https://github.com/maus-inc/mausVoice/actions/workflows/test-desktop-unit.yml"><img src="https://img.shields.io/github/actions/workflow/status/maus-inc/mausVoice/test-desktop-unit.yml?branch=main&label=CI&style=flat&color=000000&labelColor=000000" alt="CI" /></a> <a href="https://github.com/maus-inc/mausVoice/releases/latest"><img src="https://img.shields.io/github/v/release/maus-inc/mausVoice?style=flat&labelColor=000000&color=000000" alt="Latest stable release" /></a>

</div>

> [!TIP]
> Grab your free [Groq↗](https://console.groq.com/keys) and [Deepgram↗](https://console.deepgram.com/) API keys.

<div align="center">

<br>

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

<br>
<br>
<p align="center">
  <img src="docs/assets/animated-pill.gif" alt="mausVoice pill in action" width="200" />
</p>

## Features

Every stage is configurable: capture globally, select the transcription path that fits the moment, then control exactly how the finished text reaches the focused app.

<p align="center">
  <a href="#global-dictation">Global dictation</a>
  &nbsp;·&nbsp;
  <a href="#transcription-engines">Transcription engines</a>
  &nbsp;·&nbsp;
  <a href="#writing-styles">Writing styles</a>
  &nbsp;·&nbsp;
  <a href="#dictionary-and-history">Dictionary &amp; history</a>
  &nbsp;·&nbsp;
  <a href="#assistant-approval">Assistant</a>
</p>

<br />

<a id="global-dictation"></a>

<p align="center">
  <img src="docs/assets/features/dictate-anywhere.png" alt="Global dictation with live listening waveform" width="100%" />
</p>

<p align="center"><sub><strong>01 / GLOBAL DICTATION</strong></sub></p>
<h3 align="center">Your voice, in the field with focus</h3>

<p align="center">
  Hold a global push-to-talk shortcut and speak into the app you are already using.<br />
  mausVoice can paste, type directly, or leave the result on your clipboard.
</p>

<br />

<a id="transcription-engines"></a>

<p align="center">
  <img src="docs/assets/features/choose-your-engine.png" alt="Local and API transcription engine choices" width="100%" />
</p>

<p align="center"><sub><strong>02 / TRANSCRIPTION ENGINES</strong></sub></p>
<h3 align="center">Local or hosted. Pick the transcription path.</h3>

<p align="center">
  Run Whisper, Parakeet, or Canary locally on CPU or a detected Vulkan GPU, or choose a hosted provider.<br />
  Bring your own credentials; local recognition stays on-device once its model is downloaded.
</p>

<br />

<a id="writing-styles"></a>

<p align="center">
  <img src="docs/assets/features/writing-styles.png" alt="Writing styles for mail, chat, and terminal text" width="100%" />
</p>

<p align="center"><sub><strong>03 / WRITING STYLES</strong></sub></p>
<h3 align="center">Say it once. Shape it for the destination.</h3>

<p align="center">
  Create reusable instructions for email, chat, terminal work, or any voice you need.<br />
  Choose the style before recording, or switch post-processing off for a literal transcript.
</p>

<br />

<a id="dictionary-and-history"></a>

<p align="center">
  <img src="docs/assets/features/dictionary-history.png" alt="Dictionary replacement rule and inspectable transcription history" width="100%" />
</p>

<p align="center"><sub><strong>04 / DICTIONARY &amp; HISTORY</strong></sub></p>
<h3 align="center">Teach it your vocabulary. Keep the useful trail.</h3>

<p align="center">
  Add replacement rules for names, acronyms, and phrases that general models miss.<br />
  Review raw and final text, play retained audio, or retranscribe a saved clip with current settings.
</p>

<br />

<a id="assistant-approval"></a>

<p align="center">
  <img src="docs/assets/features/assistant-approval.png" alt="mausVoice Assistant with command approval controls" width="100%" />
</p>

<p align="center"><sub><strong>05 / ASSISTANT</strong></sub></p>
<h3 align="center">Ask for action. Approve every command.</h3>

<p align="center">
  Use voice or text to work with the built-in Assistant and its permissioned tools.<br />
  Requests pause for Deny, Allow, or Always allow; Power Mode keeps shell access off until enabled.
</p>

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

> [!WARNING]
> **mausVoice is currently in very early beta.** Although it is not expected during normal use, you may encounter undocumented behavior or bugs carried over from the app's pre-alpha stage.
>
> If you find a bug, please [open an issue](https://github.com/maus-inc/mausVoice/issues/new) and be as detailed as possible. Include the steps to reproduce it, what you expected, what happened, your platform and mausVoice version, and, when possible, a screenshot and sanitized diagnostic logs.
>
> We welcome these reports. They help us, as a community, improve the app for one another. 😊

<details>
<summary><strong>How to find and attach mausVoice logs</strong></summary>

### Recommended on every platform

1. Open **mausVoice → Settings → General → Diagnostics**.
2. Select **Open** to reveal the log directory, or **Download** to export `mausvoice-diagnostics.zip`.
3. Inspect the files before sharing them. Remove names, email addresses, private paths, transcript fragments, provider responses, API keys, and anything unrelated to the report.
4. Attach the sanitized archive to your GitHub issue with a screenshot and clear reproduction steps.

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
~/.local/share/com.mausinc.desktop/logs
```

If `XDG_DATA_HOME` is set, use `$XDG_DATA_HOME/com.mausinc.desktop/logs` instead. Local development builds use `com.mausinc.desktop.local` as the identifier on every platform.

</details>

<div align="center"><sub>Leave a ⭐</sub></div>

<br>
<div align="center">
  

<img src="docs/assets/mausVoicetopbanner.png" alt="mausVoice top-banner" width="700" />

  <br>
  <br>
  
  <img src="docs/assets/animated-pill.gif" alt="mausVoice pill in action" width="200" />

  <br>
  
# mausVoice <a href="https://github.com/maus-inc/mausVoice/actions/workflows/test-desktop-unit.yml"><img src="https://img.shields.io/github/actions/workflow/status/maus-inc/mausVoice/test-desktop-unit.yml?branch=main&label=CI&style=flat&color=000000&labelColor=000000" alt="CI" /></a>

</div>

> [!TIP]
> Grab your [Groq↗](https://console.groq.com/keys) and [Deepgram↗](https://console.deepgram.com/) API keys, for quick, free transcription inference.
>
> Transcription accuracy **varies** by STT provider or model; transcripts **may not** be 100 percent accurate due to differences in intonation, accent, and input device. We **continually** optimize the client-side pipeline to improve transcription speed and accuracy.

<br>

<div align="center">

[![license: AGPL-3.0](docs/assets/badges/license.svg)](LICENCE)
[![macOS builds available](docs/assets/badges/macos.svg)](https://github.com/maus-inc/mausVoice/releases)
[![Windows builds available](docs/assets/badges/windows.svg)](https://github.com/maus-inc/mausVoice/releases)
[![Linux builds available](docs/assets/badges/linux.svg)](https://github.com/maus-inc/mausVoice/releases)

<sub>**Voice typing for your own machine, dictate into any app and clean it up with AI, no account or subscription needed, and the Rust core keeps CPU and memory usage low.**</sub>

<br>

</div>



<p align="center">
  <img src="docs/assets/home-page.png" alt="mausVoice home" width="750" />
</p>

**mausVoice** is a voice transcription desktop app turning your voice into text anywhere you can type. Hold your shortcut hotkeys, speak, and release. mausVoice transcribes locally or through your chosen cloud provider, with the option to apply an additional **LLM** cleanup and your selected writing style, and sends the result to the field in focus.

## How it works

1. Press your hotkey and speak. A small overlay shows you're recording.
2. Audio is captured natively and transcribed as it happens, with streaming-capable Deepgram ([`nova-3`](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api)), or with fully local Whisper, ONYX or SenseVoice models if you'd rather keep every byte on-device.
3. Optionally, An LLM cleans up the transcript. It removes filler, fixes punctuation and formatting, and applies your chosen writing style.
4. The finished text lands in whatever app you're focused on.
<br>

<br>
<br>
<p align="center">
  <img src="branding/mausvoice-logo-256.png" alt="mausVoice logo" width="88" />
</p>

## Features

|                          |                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Live transcription**   | The streaming `nova-3` transcript appears while you're still speaking, so it's ready before you release the hotkey.                  |
| **Fully local option**   | Run Whisper locally (CPU or GPU) with zero network calls for transcription.                                                          |
| **AI cleanup**           | Removes filler words and fixes punctuation. Choose a writing style and the result reads like you wrote it.                           |
| **Your keys, encrypted** | Deepgram and Groq keys live on your machine, encrypted with XChaCha20-Poly1305. Rotate them any time in Settings without rebuilding. |
| **Personal dictionary**  | Add your names, jargon, and shorthand once and mausVoice remembers them.                                                             |
| **Works in every app**   | The overlay captures audio globally and pastes the result into whatever has focus.                                                   |

<br>
<br>

## Documentation

**New to mausVoice, looking for a feature, trying to find guidance, tuning a provider, or building from source? Visit the complete [mausVoice Documentation](https://maus-inc.github.io/mausVoice/docs/).** It covers platform setup, daily dictation, every configuration area, provider behavior, privacy and local data, troubleshooting, and the repository architecture.

<p align="center">
  <a href="https://maus-inc.github.io/mausVoice/docs/"> 
  <img src="docs/assets/readthedocsbtn.png" alt="mausVoice readthedocs button" width="320" />
  </a>
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
> We welcome these reports, since they help us, as a community, improve the app for one another.

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

If `XDG_DATA_HOME` is set, use `$XDG_DATA_HOME/com.mausinc.desktop/logs` instead. Local development builds may use `com.mausinc.desktop.local` or `com.mausinc.desktop.dev` as the identifier on every platform.

</details>

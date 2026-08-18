<div align="center">

<img src="branding/mausvoice-logo-256.png" alt="mausVoice logo" width="88" />

# mausVoice

Grab Your [Free Groq↗](https://console.groq.com/keys) and [Free Deepgram↗](https://console.deepgram.com/) API Keys.

<br>

**Voice typing for your own machine. Dictate into any app and clean it up with AI. With no account or subscription, written in Rust for high performance and minimal CPU and memory usage.**

[![license](https://shieldcn.dev/badge/license-AGPL--3.0-black.svg)](LICENCE)
[![CI](https://shieldcn.dev/badge/CI-passing-black.svg)](https://github.com/maus-inc/mausVoice/actions)
[![macOS](https://shieldcn.dev/badge/-black.svg?logo=apple)](https://github.com/maus-inc/mausVoice/releases)
[![Windows](https://shieldcn.dev/badge/-black.svg?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMy40NDlMOS43NSAyLjF2OS40NTFIMG0xMC45NDktOS42MDJMMjQgMHYxMS40SDEwLjk0OU0wIDEyLjZoOS43NXY5LjQ1MUwwIDIwLjY5OU0xMC45NDkgMTIuNkgyNFYyNGwtMTIuOS0xLjgwMSIvPjwvc3ZnPg%3D%3D)](https://github.com/maus-inc/mausVoice/releases)
[![Linux](https://shieldcn.dev/badge/-black.svg?logo=linux)](https://github.com/maus-inc/mausVoice/releases)

</div>

## Documentation

**New to mausVoice, tuning a provider, or building from source? Visit the complete [mausVoice Documentation](https://maus-inc.github.io/mausVoice/docs/).** It covers platform setup, daily dictation, every configuration area, provider behavior, privacy and local data, troubleshooting, and the repository architecture.

<p align="center">
  <a href="https://maus-inc.github.io/mausVoice/docs/"><strong>Read the docs →</strong></a>
</p>

<p align="center">
  <img src="docs/assets/home-page.png" alt="mausVoice home" width="720" />
</p>

**mausVoice** is a desktop app that turns your voice into text anywhere you can type. Hold a global shortcut, speak, and release: mausVoice transcribes locally or through your chosen provider, optionally applies an **LLM** writing style, and sends the result to the field in focus.

## How it works

1. Press your hotkey and speak. A small overlay shows you're recording.
2. Audio is captured natively and transcribed as it happens, with streaming Deepgram (`nova-3`), or with fully local Whisper if you'd rather keep every byte on-device.
3. The transcript is cleaned up with an LLM: filler removed, punctuation and formatting in, your chosen writing style applied.
4. The finished text lands in whatever app you're focused on.
<br>

<br>
<br>
<p align="center">
  <img src="docs/assets/animated-pill.gif" alt="mausVoice pill in action" width="200" />
</p>

## Features

|                          |                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Live transcription**   | Streaming `nova-3` transcript appears while you're still speaking. It's ready before you stop talking.                               |
| **Fully local option**   | Run Whisper locally (CPU or GPU) with zero network calls for transcription.                                                          |
| **AI cleanup**           | Filler words out, structure in. Choose a writing style and the result reads like you wrote it.                                       |
| **Your keys, encrypted** | Deepgram and Groq keys live on your machine, encrypted with XChaCha20-Poly1305. Rotate them any time in Settings without rebuilding. |
| **Personal dictionary**  | Add your names, jargon, and shorthand once and mausVoice remembers them.                                                             |
| **Works in every app**   | The overlay captures audio globally and pastes the result into whatever has focus.                                                   |

<p align="center">
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="https://shieldcn.dev/badge/-black.svg?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMy40NDlMOS43NSAyLjF2OS40NTFIMG0xMC45NDktOS42MDJMMjQgMHYxMS40SDEwLjk0OU0wIDEyLjZoOS43NXY5LjQ1MUwwIDIwLjY5OU0xMC45NDkgMTIuNkgyNFYyNGwtMTIuOS0xLjgwMSIvPjwvc3ZnPg%3D%3D" alt="Download mausVoice for Windows" height="32" />
  </a>
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="https://shieldcn.dev/badge/-black.svg?logo=apple" alt="Download mausVoice for macOS" height="32" />
  </a>
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="https://shieldcn.dev/badge/-black.svg?logo=linux" alt="Download mausVoice for Linux" height="32" />
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

You'll need macOS, Windows, or Linux, plus Node 18+, pnpm 10, and a Rust toolchain (see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

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

On first launch, the onboarding asks for your transcription and cleanup keys. That's it. There are no build-time secrets, and the same binary works for the local Whisper path.

### API keys & configuration

Two optional keys, both entered in Settings:

- **Deepgram** (streaming transcription) — [get one here](https://console.deepgram.com/). If you skip it, mausVoice falls back to local Whisper.
- **Groq** (LLM text cleanup) — [get one here](https://console.groq.com/keys).

Keys are stored encrypted on your machine and can be changed or rotated any time without rebuilding. For a fully offline setup, leave both empty and point at a downloaded Whisper model.

## Build & quality

From the repo root:

```bash
pnpm run build         # build all workspaces (turborepo)
pnpm run lint          # lint
pnpm run check-types   # TypeScript type checking
pnpm run test          # tests
```

Authoritative docs: [mausVoice Documentation](https://maus-inc.github.io/mausVoice/docs/) — architecture is under [Desktop architecture](https://maus-inc.github.io/mausVoice/docs/development/architecture/). Agent package name is `@repo/agent`.

</details>

## License

[AGPLv3](LICENCE). Built on [Tauri](https://tauri.app), with the frontend in React and the audio/overlay layer in Rust.

**Maintainer:** [Owie Emmanuel](https://github.com/Owie6789)

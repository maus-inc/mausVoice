<div align="center">

<img src="branding/mausvoice-logo-256.png" alt="mausVoice logo" width="88" />

# mausVoice

**Voice typing for your own machine. Dictate into any app and clean it up with AI. No account. No subscription.**

[![license](https://shieldcn.dev/badge/license-AGPL--3.0-black.svg)](LICENCE)
[![CI](https://shieldcn.dev/badge/CI-passing-black.svg)](https://github.com/maus-inc/mausVoice/actions)
[![macOS](https://shieldcn.dev/badge/-black.svg?logo=apple)](https://github.com/maus-inc/mausVoice/releases)
[![Windows](https://shieldcn.dev/badge/-black.svg?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMy40NDlMOS43NSAyLjF2OS40NTFIMG0xMC45NDktOS42MDJMMjQgMHYxMS40SDEwLjk0OU0wIDEyLjZoOS43NXY5LjQ1MUwwIDIwLjY5OU0xMC45NDkgMTIuNkgyNFYyNGwtMTIuOS0xLjgwMSIvPjwvc3ZnPg%3D%3D)](https://github.com/maus-inc/mausVoice/releases)
[![Linux](https://shieldcn.dev/badge/-black.svg?logo=linux)](https://github.com/maus-inc/mausVoice/releases)

</div>

<p align="center">
  <img src="docs/home-page.png" alt="mausVoice home" width="720" />
</p>

mausVoice is a desktop app that turns your voice into text, anywhere you can type. Speech is transcribed live while you talk, tidied up by an LLM in the style you pick, and dropped straight into the app you're focused on.

## How it works

1. Press your hotkey and speak. A small overlay shows you're recording.
2. Audio is captured natively and transcribed as it happens, with streaming Deepgram (`nova-3`), or with fully local Whisper if you'd rather keep every byte on-device.
3. The transcript is cleaned up with an LLM: filler removed, punctuation and formatting in, your chosen writing style applied.
4. The finished text lands in whatever app you're focused on.

## Features

| | |
| --- | --- |
| **Live transcription** | Streaming `nova-3` transcript appears while you're still speaking. It's ready before you stop talking. |
| **Fully local option** | Run Whisper locally (CPU or GPU) with zero network calls for transcription. |
| **AI cleanup** | Filler words out, structure in. Choose a writing style and the result reads like you wrote it. |
| **Your keys, encrypted** | Deepgram and Groq keys live on your machine, encrypted with XChaCha20-Poly1305. Rotate them any time in Settings without rebuilding. |
| **Personal dictionary** | Add your names, jargon, and shorthand once and mausVoice remembers them. |
| **Works in every app** | The overlay captures audio globally and pastes the result into whatever has focus. |

<p align="center">
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="https://shieldcn.dev/badge/Windows-Download-black.svg?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMy40NDlMOS43NSAyLjF2OS40NTFIMG0xMC45NDktOS42MDJMMjQgMHYxMS40SDEwLjk0OU0wIDEyLjZoOS43NXY5LjQ1MUwwIDIwLjY5OU0xMC45NDkgMTIuNkgyNFYyNGwtMTIuOS0xLjgwMSIvPjwvc3ZnPg%3D%3D" alt="Download mausVoice for Windows" />
  </a>
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="https://shieldcn.dev/badge/macOS-Download-black.svg?logo=apple" alt="Download mausVoice for macOS" />
  </a>
  <a href="https://github.com/maus-inc/mausVoice/releases">
    <img src="https://shieldcn.dev/badge/Linux-Download-black.svg?logo=linux" alt="Download mausVoice for Linux" />
  </a>
</p>

Download links point at the latest release for your platform (`.exe` on Windows, `.dmg` on macOS, `.AppImage` or `.deb` on Linux).

<details>
<summary>Developers quick start</summary>

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

</details>

## License

[AGPLv3](LICENCE). Built on [Tauri](https://tauri.app), with the frontend in React and the audio/overlay layer in Rust.

**Maintainer:** Owie Emmanuel <owieemmanuel34@gmail.com>
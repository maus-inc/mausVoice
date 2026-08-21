<div align="center">

<img src="branding/mausvoice-logo-256.png" alt="mausVoice logo" width="88" />

# mausVoice <a href="https://github.com/maus-inc/mausVoice/actions/workflows/test-desktop-unit.yml"><img src="https://img.shields.io/github/actions/workflow/status/maus-inc/mausVoice/test-desktop-unit.yml?branch=main&label=CI&style=flat&color=000000&labelColor=000000" alt="CI" /></a> <a href="https://github.com/maus-inc/mausVoice/releases/latest"><img src="https://img.shields.io/github/v/release/maus-inc/mausVoice?style=flat&labelColor=000000&color=000000" alt="Latest stable release" /></a>

Grab your free [Groq↗](https://console.groq.com/keys) and [Deepgram↗](https://console.deepgram.com/) API keys.

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

![mausVoice global dictation flow from hotkey to focused field](docs/assets/features/dictate-anywhere.png)

### Your voice, in the field with focus

Hold the global shortcut, speak, and release. The native pill follows capture while mausVoice transcribes and delivers the result to the field that has focus. Use clipboard paste for speed, simulated typing for stubborn apps, or committed-segment real-time output with Verbatim and a compatible streaming provider.

![mausVoice transcription settings with local and connected provider paths](docs/assets/features/choose-your-engine.png)

### Local or live—pick the transcription path

Keep speech on-device with downloadable Whisper and NeMo/Sherpa-ONNX models on CPU or GPU, or connect your own provider for API and streaming transcription. Bring your own credentials; mausVoice encrypts the full secrets at rest in local SQLite with XChaCha20-Poly1305.

![mausVoice writing styles mapped to apps with a raw and final transcript preview](docs/assets/features/writing-styles.png)

### Style per app, or choose it yourself

Optional post-processing applies a writing style after deterministic replacements. Select styles manually or map a default to each app—concise in Mail, conversational in chat, Verbatim in a terminal. Turn processing off and the unrewritten transcript remains the output.

![mausVoice dictionary rules and inspectable transcription history](docs/assets/features/dictionary-history.png)

### Teach the words. Trace the pipeline.

Glossary hints help supported transcription paths recognize names, acronyms, and jargon. Replacement rules make exact corrections or expand spoken snippets before an optional rewrite. History separates raw, replaced, and final text, with available audio playback, re-transcription, and provider, model, warning, and timing details.

![mausVoice Assistant requesting approval before pasting into the focused field](docs/assets/features/assistant-approval.png)

### An assistant that asks before it acts

Experimental Assistant mode sends a separate voice shortcut into a conversation instead of ordinary dictation. It can inspect focused context and request a paste, but permissioned tools stop for **Deny**, **Allow**, or **Always allow**. Power Mode additionally exposes shell commands and should stay off unless a task genuinely needs them.

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

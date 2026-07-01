<div align="center">

<img src="docs/graphic.png" alt="Voquill Logo" width="400" />

# Voquill — Personal Local Build

### Voice typing for your own machine. Dictate into any app, clean it up with AI, no account and no subscription.

</div>

---

This is a personal, non-commercial fork of [Voquill](https://github.com/voquill/voquill), an open-source AI voice-typing desktop app. It has been trimmed and rewired to run entirely for personal use with **your own Deepgram and Groq API keys** — no Voquill account, no paywall, and no "Pro" gating.

> Looking for the upstream project, its hosted plans, mobile app, or marketing copy? See [`README.original.md`](README.original.md) and [voquill.com](https://voquill.com).

## What this fork changes

- **No paywall / no Pro account gating.** All capabilities are available locally. The cloud account, billing, and trial flows are bypassed.
- **Personal-use mode by default.** The app signs you in as a local user (no Firebase account) and configures sensible defaults automatically.
- **Bring-your-own keys.** Out of the box, transcription uses **Deepgram streaming** (`nova-3`) over your Deepgram key — audio is transcribed live while you speak, so the transcript is ready almost as soon as you stop — and post-processing uses Groq `openai/gpt-oss-20b` over your Groq key. You enter both keys on first run (or in Settings); they are stored encrypted (XChaCha20-Poly1305) on your machine and are never baked into the build.
- **Fully-local option still available.** You can also run Whisper locally (CPU or GPU) instead of the cloud APIs if you prefer zero network calls for transcription.
- **Removed what I don't use.** The Flutter mobile app (`mobile/`), the `flutter_video_looper` package, and Linux desktop support have been removed to keep the tree focused on the macOS/Windows desktop app.

Everything else — the dictation overlay, hotkeys, AI text cleanup, personal dictionary, writing styles, and the voice assistant — works as in upstream.

## How it works (short version)

1. You press your hotkey and speak; an overlay "pill" shows recording state.
2. Audio is captured natively (Rust) and sent to your chosen transcription engine (local Whisper, or Deepgram streaming transcription with your key).
3. The transcript is optionally cleaned up by an LLM (filler removal, formatting) using your selected writing style.
4. The result is pasted into whatever app you're focused on.

For the full picture — the monorepo layout, the "Rust is the API, TypeScript is the Brain" design, the repo/action/command data flow, and every feature subsystem — read **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

## Requirements

- macOS or Windows
- Node.js 18+ and pnpm 10
- Rust 1.77+ (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- For the default cloud path: a [Deepgram API key](https://console.deepgram.com/) (streaming transcription) and a [Groq API key](https://console.groq.com/keys) (AI cleanup). For the fully-local path: a downloaded Whisper model instead.

## Setup

```bash
pnpm install
```

There are no build-time keys. On first launch, the onboarding **"Connect your API keys"** step asks for your Deepgram (transcription) and Groq (AI cleanup) keys. Both are stored encrypted locally and can be changed or rotated any time in **Settings** — no rebuild required.

## Run

From `apps/desktop` (platform-specific commands are required for native features):

```bash
cd apps/desktop
pnpm dev:mac          # macOS
pnpm dev:windows      # Windows
```

> Do not use `pnpm dev` directly — use the platform-specific command above.

## Build & quality (run from the repo root)

```bash
pnpm run build         # build all workspaces (turborepo)
pnpm run lint          # lint
pnpm run check-types   # TypeScript type checking
pnpm run test          # tests
```

## License & attribution

This fork inherits Voquill's **AGPLv3** license. See [`LICENCE`](LICENCE) for the full terms and third-party attributions. All credit for the original application goes to the Voquill authors and contributors. This build is intended strictly for personal, non-commercial use.

<div align="center">

<img src="docs/graphic.png" alt="Voquill Logo" width="400" />

# Voquill — Personal Local Build

### Voice typing for your own machine. Dictate into any app, clean it up with AI, no account and no subscription.

</div>

---

This is a personal, non-commercial fork of [Voquill](https://github.com/voquill/voquill), an open-source AI voice-typing desktop app. It has been trimmed and rewired to run entirely for personal use with **your own Groq API key** — no Voquill account, no paywall, and no "Pro" gating.

> Looking for the upstream project, its hosted plans, mobile app, or marketing copy? See [`README.original.md`](README.original.md) and [voquill.com](https://voquill.com).

## What this fork changes

- **No paywall / no Pro account gating.** All capabilities are available locally. The cloud account, billing, and trial flows are bypassed.
- **Personal-use mode by default.** The app signs you in as a local user (no Firebase account) and configures sensible defaults automatically.
- **Bring-your-own Groq key.** Out of the box, transcription uses Groq-hosted `whisper-large-v3-turbo` and post-processing uses `openai/gpt-oss-20b`, both via your personal Groq API key. The key is read only at runtime (env var or local `.env.local`) and stored encrypted on your machine — it is never baked into the build.
- **Fully-local option still available.** You can also run Whisper locally (CPU or GPU) instead of the Groq API if you prefer zero network calls for transcription.
- **Removed what I don't use.** The Flutter mobile app (`mobile/`), the `flutter_video_looper` package, and Linux desktop support have been removed to keep the tree focused on the macOS/Windows desktop app.

Everything else — the dictation overlay, hotkeys, AI text cleanup, personal dictionary, writing styles, and the voice assistant — works as in upstream.

## How it works (short version)

1. You press your hotkey and speak; an overlay "pill" shows recording state.
2. Audio is captured natively (Rust) and sent to your chosen transcription engine (local Whisper or the Groq API with your key).
3. The transcript is optionally cleaned up by an LLM (filler removal, formatting) using your selected writing style.
4. The result is pasted into whatever app you're focused on.

For the full picture — the monorepo layout, the "Rust is the API, TypeScript is the Brain" design, the repo/action/command data flow, and every feature subsystem — read **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

## Requirements

- macOS or Windows
- Node.js 18+ and pnpm 10
- Rust 1.77+ (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- A [Groq API key](https://console.groq.com/keys) (for the default cloud-API path), or a downloaded Whisper model (for the fully-local path)

## Setup

```bash
pnpm install

# Optional: provide your Groq key so the app auto-configures on first run.
# Copy the example and fill in your key.
cp apps/desktop/.env.local.example apps/desktop/.env.local
```

`apps/desktop/.env.local` accepts any of `VOQUILL_GROQ_API_KEY`, `GROQ_API_KEY`, or `VITE_GROQ_API_KEY`. You can also just paste the key into the onboarding screen or Settings instead.

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

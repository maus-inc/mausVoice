# mausVoice Desktop

Cross-platform voice-to-text desktop app (Tauri 2: Rust API + TypeScript/React brain).

Authoritative docs: [Desktop architecture](https://maus-inc.github.io/mausVoice/docs/development/architecture/) and [Development setup](https://maus-inc.github.io/mausVoice/docs/development/setup/).

## Prerequisites

- **Node.js from repo `.nvmrc` (v24).** Root `engines.node` is `>=20`.
- **pnpm 10.34.5** (do not use npm for workspace scripts).
- **Rust** stable (Tauri v2; 1.77+ historical floor) and **CMake** (whisper-rs).
- Platform tools: Xcode CLT (macOS), VS Build Tools (Windows). Linux deps: `.github/scripts/install-desktop-linux-deps.sh`.

From the **repository root**:

```bash
pnpm install
```

macOS toolchain check: `./scripts/setup-macos.sh`.

## Running locally

Native features need the platform command (sets `TAURI_PLATFORM`, prepares sidecars):

```bash
# from repo root
pnpm --filter desktop dev:mac
pnpm --filter desktop dev:windows
pnpm --filter desktop dev:linux
```

Or from this directory: `pnpm dev:mac` / `dev:windows` / `dev:linux`.

Do not use bare `pnpm dev` / `npm run dev` for native work. Generic `pnpm dev` only runs the platform-selection helper.

Local flavor uses identifier `com.mausinc.desktop.local` via `src-tauri/tauri.local.conf.json`.

## Build & quality

From repo root:

```bash
pnpm exec turbo run build --filter=desktop^...
pnpm --filter desktop run check-types
pnpm --filter desktop lint
pnpm --filter desktop test:unit
pnpm --filter desktop test:integration  # requires GROQ_API_KEY; see .env.local.example
pnpm --filter desktop test:evals        # requires GROQ_API_KEY; see .env.local.example
```

`check-types` needs workspace packages (`@repo/agent`, `@maus-inc/*`) built first.

`pnpm --filter desktop build` is the Vite/TS frontend only. Packaged native builds go through `pnpm --filter desktop tauri build` / the OS-specific Tauri build after sidecars exist.

## Project structure

```
src/
├── actions/         # Business-logic orchestration
├── components/      # React UI
├── hooks/           # Store / React hooks
├── repos/           # Local SQLite + AI provider access
├── sessions/        # Live transcription transports
├── sidecars/        # rust_transcription process leases
├── state/           # Zustand slices
├── store/           # Combined store
├── strategies/      # Dictation behavior
├── tools/           # Assistant tools
└── utils/           # Pure helpers (prompts, tones, strings)

src-tauri/
└── src/
    ├── commands.rs  # Tauri commands (TS ↔ Rust)
    ├── app.rs       # Plugin / invoke_handler setup
    ├── db/          # SQLite migrations and queries
    ├── domain/      # Rust domain models
    ├── platform/    # macOS / Windows / Linux
    └── system/      # Crypto, paths, GPU, tray, remote I/O
```

## Architecture

**Rust is the API, TypeScript is the Brain.** Zustand + Immer is the single store. Repos in this build resolve to local SQLite and local or API-backed providers — there is no hosted cloud backend.

Personal defaults: Deepgram `nova-3` streaming when a Deepgram key exists; Groq `whisper-large-v3-turbo` as batch fallback. Post-processing is a separate API/Off switch (Groq default `openai/gpt-oss-20b`). Local Whisper/ONNX does **not** turn cleanup off.

Keys are entered in Settings / onboarding and stored with XChaCha20-Poly1305. Nothing is baked into the binary.

## Environment variables

| Variable | Description |
| --- | --- |
| `VITE_FLAVOR` | `emulators` (dev default), `dev`, `prod`. `enterprise` / `enterprise-dev` are leftover flavor names, not live backends. |
| `MAUSVOICE_ENABLE_DEVTOOLS` | Open webview devtools on startup |
| `MAUSVOICE_DESKTOP_PLATFORM` | Override platform detection for Node scripts |
| `TAURI_PLATFORM` | Set by `dev:mac` / `dev:windows` / `dev:linux` |
| `TAURI_DEV_CONFIG` | Alternate Tauri config |
| `MAUSVOICE_API_KEY_SECRET` | Optional explicit at-rest key secret |

## Internationalization

react-intl with auto-generated message IDs. Never pass an `id` prop.

```bash
pnpm --filter desktop i18n          # extract + sync
pnpm --filter desktop i18n:extract
pnpm --filter desktop i18n:sync
```

## Bindings

After changing `#[tauri::command]` signatures: from repo root `pnpm gen:bindings` (Specta → `packages/desktop-native-apis`; collector is `src-tauri/examples/gen_bindings.rs`).

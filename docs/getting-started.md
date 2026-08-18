# Getting Started

> **Maintained guide:** [Development setup](https://maus-inc.github.io/mausVoice/docs/development/setup/). This file is a short pointer for people who land in `docs/`.

## Monorepo

**pnpm 10.11.0** + Turborepo. Do not use npm for workspace scripts.

| Path | Description |
| --- | --- |
| `apps/desktop` | Tauri desktop app (Vite + React + Zustand) |
| `apps/desktop/src-tauri` | Rust API, SQLite, overlays, sidecar bridge |
| `apps/docs` | Authoritative Astro + Starlight docs |
| `apps/windows-installer` | Windows NSIS bootstrapper (Tauri) |
| `packages/*` | `@maus-inc/types`, utilities, voice-ai, **`@repo/agent`**, desktop-native-apis, desktop-utils, firemix, fonts, lint/tsconfig, pill crates, `rust_transcription` |
| `docs` | Historical notes — prefer `apps/docs` when they disagree |

There is no `apps/web`, `apps/firebase`, or `enterprise/` application in this checkout.

## Architecture

Rust is the API; TypeScript is the Brain. Zustand is the store. Repos resolve to local SQLite and local or API providers.

See [desktop architecture](https://maus-inc.github.io/mausVoice/docs/development/architecture/) and `ARCHITECTURE.md` (historical walkthrough).

## Prerequisites

- Node from **`.nvmrc` (v24)**; `engines.node` is `>=20`
- pnpm 10.11.0
- Rust + CMake
- Tauri OS prerequisites. Windows: `powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/setup-windows.ps1` (`-EnableGpu` for Vulkan). macOS: `./scripts/setup-macos.sh`

API keys (optional) are entered **in the app**, not via env: Deepgram (streaming STT), Groq (cleanup / fallback STT). Empty keys + a downloaded local model = recognition without those providers. Cleanup is still a separate setting.

## Commands

```sh
pnpm install
pnpm run build

pnpm --filter desktop run dev:mac
pnpm --filter desktop run dev:windows
pnpm --filter desktop run dev:linux

pnpm --filter docs run dev

pnpm run lint
pnpm run check-types
pnpm run test
pnpm gen:bindings
```

Override platform detection with `MAUSVOICE_DESKTOP_PLATFORM` if needed. Desktop dev defaults to the `emulators` flavor; that does **not** restore a hosted backend.

## Releases

Manual-dispatch `.github/workflows/release.yml`. See `RELEASE.md` and [Release process](https://maus-inc.github.io/mausVoice/docs/development/releases/).

## License

AGPLv3 — `LICENCE`.

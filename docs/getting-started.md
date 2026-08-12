# Getting Started

## Monorepo Layout

This is a **pnpm** workspace (`pnpm@10.11.0`) managed with Turborepo. The package manager is declared in the root `package.json` and driven by `pnpm-lock.yaml` — do not use `npm`.

| Path                     | Description                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`           | Tauri desktop app (Vite + React + Zustand) controlling UI, state, and business logic.                                                       |
| `apps/desktop/src-tauri` | Rust API layer invoked from TypeScript for native capabilities, SQLite storage, and Whisper inference.                                      |
| `apps/docs`              | Astro + Starlight documentation site.                                                                                                       |
| `apps/windows-installer` | Windows installer (Tauri).                                                                                                                  |
| `docs`                   | Architecture notes, release guides, and reference material.                                                                                 |
| `enterprise/*`           | Enterprise administrative dashboard and API gateway.                                                                                        |
| `packages/*`             | Shared packages: types, voice-ai, desktop-native-apis, functions, pricing, UI, utilities, config, shared-fonts, and the native pill crates. |
| `scripts`                | Automation and helper scripts for local development and release tasks.                                                                      |

> The marketing site (`apps/web`) and Firebase functions (`apps/firebase`) referenced in some legacy docs are **not part of this repository**. The marketing site and its install scripts are served from `https://maus-inc.github.io/mausVoice/` externally.

## Architecture Overview

The desktop app follows a TypeScript-first design: Zustand maintains a single global store, while pure utility functions in `apps/desktop/src/utils` read and mutate state. Actions compose those utilities and may call out to repositories. Repos abstract whether persistence happens locally (SQLite through Tauri commands) or remotely (Docker / external services).

```
User input / system events
        ↓
React + Zustand state (TypeScript)
        ↓
Repos choose local vs. remote storage
        ↓
Tauri commands (Rust API bridge)
        ↓
SQLite, Whisper models, or external services
```

Rust stays focused on native integrations—audio capture, keyboard injection, updater, encryption, GPU enumeration, filesystem paths. TypeScript owns business logic, routing, and UI.

See `desktop-architecture.md` for the full tour.

## Prerequisites

- Node.js 18+ and pnpm 10.
- Rust toolchain with `cargo`, `rustup`, and the Tauri CLI (`cargo install tauri-cli`).
- Platform dependencies for Tauri on macOS or Windows. On Windows use `powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/setup-windows.ps1` (add `-EnableGpu` to pull the Vulkan SDK for GPU builds).
- API keys for hosted transcription/cleanup: a **Deepgram** key (streaming transcription) and a **Groq** key (transcript cleanup). In the desktop app you enter these in-app (onboarding / Settings), not via env vars.

## Install dependencies

```sh
pnpm install
```

## Build everything

Use the prepared `turbo` task:

```sh
pnpm run build
```

## Run the desktop app

Pick the platform-specific script; avoid `turbo dev` since the desktop app manages its own watcher.

```sh
# Mac
pnpm --filter desktop run dev:mac

# Windows
pnpm --filter desktop run dev:windows
```

During local development you can override platform detection by exporting `MAUSVOICE_DESKTOP_PLATFORM` (`darwin` or `win32`). The desktop dev journey defaults to the `emulators` flavor (`apps/desktop/.env.emulators`); pass `FLAVOR=dev` or `VITE_FLAVOR=dev` when you want the hosted dev project.

```powershell
# Windows — make sure MSVC is initialized first, then:
pnpm --filter desktop run dev:windows
```

## Run the documentation site

```sh
pnpm --filter docs run dev
```

## Quality checks

```sh
pnpm run lint
pnpm run check-types
pnpm run test
```

Individual workspaces expose the same commands if you need a narrower scope.

## Run in prod mode

1. Comment out `devUrl` in `apps/desktop/src-tauri/tauri.conf.json`.
2. `pnpm --filter desktop run build`
3. `VITE_FLAVOR=prod pnpm tauri dev --no-dev-server`

## Environment Reference

| Variable                                                             | Purpose                                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MAUSVOICE_API_KEY_SECRET`                                           | Secret used by the desktop app to encrypt API keys stored on disk (`apps/desktop/src-tauri/src/system/crypto.rs`).                 |
| `MAUSVOICE_WHISPER_MODEL_URL` / `MAUSVOICE_WHISPER_MODEL_URL_<SIZE>` | Override download locations for Whisper models when running locally.                                                               |
| `MAUSVOICE_WHISPER_DISABLE_GPU`                                      | Force the desktop app to avoid GPU inference, useful for debugging.                                                                |
| `VITE_USE_EMULATORS`                                                 | When set to `true`, the desktop app points to local emulators instead of hosted services.                                          |
| `GROQ_API_KEY`                                                       | Enables Groq-backed transcription in server-side components. The desktop app takes its Deepgram/Groq keys via onboarding/Settings. |

## Releases & CI

- Releases run through a single manual-dispatch workflow, `.github/workflows/release.yml`: enter a version, build all three platforms (macOS universal, Windows, Linux), and publish an unsigned GitHub Release with a generated body. See `RELEASE.md` for the step-by-step runbook. No channel tags or `latest.json` manifests — mausVoice ships directly from the Releases page.
- Turbo caching is configured in `turbo.json`; CI jobs call `pnpm run build`, `pnpm run lint`, and other workspace-scoped commands.

## Documentation

- Desktop architecture: `desktop-architecture.md`
- Release playbook: `RELEASE.md`
- Additional resources and inspiration: `resources.md`
- Contributor conventions and workspace notes: `AGENTS.md` (repo root)

## License

Unless otherwise noted, mausVoice is released under the AGPLv3. See `LICENCE` for the complete terms and third-party attributions.

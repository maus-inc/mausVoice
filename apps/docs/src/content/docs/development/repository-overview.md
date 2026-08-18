---
title: "Repository overview"
description: "Map the live applications, TypeScript workspaces, Rust crates, patches, static sites, and automation."
sidebar:
  order: 1
---

mausVoice is a pnpm 10.11.0/Turborepo workspace whose root package is marked private. It contains a Tauri desktop product, static web properties, reusable TypeScript packages, and standalone Rust binaries.

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Main Tauri app (React + Zustand) |
| `apps/desktop/src-tauri` | Rust API, SQLite migrations, platform code |
| `apps/docs` | Authoritative Astro/Starlight docs |
| `apps/windows-installer` | Tauri wrapper around the Windows NSIS setup |
| `packages/types` | Zod schemas and shared types |
| `packages/utilities` | Shared TypeScript helpers |
| `packages/voice-ai` | Provider HTTP/WebSocket clients |
| `packages/agent` (`@repo/agent`) | Tool-calling agent loop |
| `packages/desktop-native-apis` | Specta-generated Tauri bindings |
| `packages/rust_transcription` | Local Whisper/ONNX sidecar |

Root scripts: `pnpm run build`, `lint`, `check-types`, `test`, `format`, `gen:bindings`. Internal deps use `workspace:*`.

## Applications and sites

- `apps/desktop/` contains the React 19/Vite frontend and its Tauri 2 backend in `src-tauri/`. Its scripts build the local transcription and native-pill sidecars before Tauri development or packaging.
- `apps/docs/` is this Astro 5/Starlight site, deployed at `/mausVoice/docs/`.
- `apps/windows-installer/` is a separate Vite/Tauri installer workspace; it is not the main desktop UI.
- Root `index.html`, `marketing/`, and `docs/assets/` form the public landing-page portion assembled with the docs in the Pages workflow.

## Shared TypeScript workspaces

`packages/types`, `utilities`, `voice-ai`, `agent`, `desktop-native-apis`, `desktop-utils`, and `firemix` own contracts, helpers, provider clients, the tool loop, generated Tauri bindings, reusable desktop logic, and Firemix integration respectively. `eslint-config` and `typescript-config` centralize tooling; `shared-fonts` stores Satoshi and TAN Paradiso assets.

## Rust and native code

- `packages/rust_transcription/` builds CPU and GPU HTTP sidecars that run whisper.cpp GGML models and ONNX Runtime Parakeet/Canary models.
- `packages/rust_{macos,windows,gtk}_pill/` implement each native overlay.
- `packages/rust_pill_shared/` shares geometry and ring-animation math—not the entire platform message protocol.
- `patches/` contains checked-in dependency fixes used by the Tauri Cargo manifest.

`scripts/` and `.github/scripts/` prepare bindings, sidecars, release text, casks, and CI environments. `.github/workflows/` separates build, lint, desktop tests, sidecar tests, docs/Pages, and releases.

`pnpm-workspace.yaml` still names `apps/firebase/functions`, but that directory is absent. Some package metadata also points at older repository coordinates. Treat the checked-out source graph and root lockfile as authoritative; do not invent an `enterprise/` or Firebase application because an old path/type remains.

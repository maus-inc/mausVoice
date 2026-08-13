---
title: "Development setup"
description: "Install the pinned JavaScript and Rust toolchains, native prerequisites, and platform-specific desktop flavor."
sidebar:
  order: 2
---

Use Node from `.nvmrc`—currently v24—even though the broad root engine floor says Node 18. CI follows `.nvmrc`. Enable Corepack or install the exact package manager from the root manifest, pnpm 10.11.0, then install from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Install stable Rust plus the normal Tauri 2 prerequisites for your OS. Linux development also needs the audio, WebKit/GTK, layer-shell, X11/uinput, compiler, CMake, and libclang dependencies used by the app and sidecars; `.github/scripts/install-desktop-linux-deps.sh` is the closest executable reference for Ubuntu.

## Start the desktop app

From `apps/desktop`, use the matching platform command:

```bash
pnpm dev:mac
pnpm dev:windows
pnpm dev:linux
```

Each sets `TAURI_PLATFORM`, runs `scripts/prepare-sidecars.mjs`, and starts Tauri with `src-tauri/tauri.local.conf.json` unless `TAURI_DEV_CONFIG` overrides it. Local flavor uses the separate identifier `com.mausinc.desktop.local`, which prevents normal development from sharing every OS-level identity with a production install. Generic `pnpm dev` runs the platform-selection script; explicit commands make bug reports repeatable.

`pnpm --filter desktop build` compiles TypeScript and the Vite frontend only. A packaged native build goes through the desktop `tauri` script or an OS-specific Tauri build command and needs sidecars present.

## Validate a change

Root `build`, `lint`, `check-types`, and `test` commands fan out through Turbo to workspaces that define those tasks. Run focused desktop unit tests before broader checks. Provider-backed integration tests require their documented environment variables; ordinary UI, repository, and sidecar unit tests must not depend on personal credentials. Keep `.env` files and generated secrets untracked.

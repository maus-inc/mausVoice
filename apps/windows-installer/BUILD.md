# Windows Installer Bootstrapper

Tauri wrapper around the desktop NSIS setup. It extracts the bundled `mausVoice_Setup.exe` and runs it silently (`/S`), then can launch `mausVoice.exe`.

Authoritative notes: [Repository overview](https://maus-inc.github.io/mausVoice/docs/development/repository-overview/) and `apps/windows-installer/`.

## Prerequisites

- Node from repo `.nvmrc` (v24); `engines.node` `>=20`
- **pnpm 10.34.5** (workspace package `@maus-inc/windows-installer`, currently `0.1.6`)
- Rust + Tauri CLI via the workspace (`pnpm --filter @maus-inc/windows-installer`, not a global npm CLI)

## Build

1. Build the main desktop NSIS installer from the repo root / `apps/desktop` (sidecars first):

```bash
pnpm --filter desktop tauri -- build
```

A native Windows host writes `mausVoice_*-setup.exe` under `apps/desktop/src-tauri/target/release/bundle/nsis/` (or `CARGO_TARGET_DIR` if CI set one). If you pass `--target x86_64-pc-windows-msvc`, Tauri places the bundle under `apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/` instead; copy from that path.

The setup's welcome/finish sidebar art comes from `mausvoice-sidebar-installerimg` (repository root) and is converted to the NSIS bitmap automatically by `scripts/generate-windows-installer-sidebar.mjs` (see `branding/README.md`); there is nothing to copy manually.

2. Copy it into the bootstrapper:

```bash
cp apps/desktop/src-tauri/target/release/bundle/nsis/mausVoice_*-setup.exe \
   apps/windows-installer/src-tauri/installer/mausVoice_Setup.exe
```

3. Build the bootstrapper:

```bash
pnpm --filter @maus-inc/windows-installer tauri:build
```

Window is 480×320, non-resizable, always-on-top, undecorated (`src-tauri/tauri.conf.json`).

## CI

Use **pnpm** with the frozen lockfile, same as the rest of the monorepo. Do not `npm install` inside `apps/windows-installer`.

## Notes

- WebView2 is bundled as an offline installer.
- First-install UX only; later updates use the desktop updater, not this wrapper.

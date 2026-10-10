# Windows Installer Bootstrapper

Tauri wrapper around the desktop NSIS setup. It extracts the bundled `mausVoice_Setup.exe` and runs it silently (`/S`), then can launch `mausVoice.exe`.

Authoritative notes: [Repository overview](https://maus-inc.github.io/mausVoice/docs/development/repository-overview/) and `apps/windows-installer/`.

## Prerequisites

- Node from repo `.nvmrc` (v24); `engines.node` `>=20`
- **pnpm 10.34.5** (workspace package `@maus-inc/windows-installer`, currently `0.1.6`)
- Rust **MSVC** toolchain and the Microsoft C++ Build Tools, on the host. Neither comes from the
  workspace: `pnpm --filter @maus-inc/windows-installer` supplies the JavaScript Tauri CLI only, and
  a native Windows build additionally needs a linker and the Windows SDK.
- Tauri CLI via the workspace (`pnpm --filter @maus-inc/windows-installer`, not a global npm CLI)

## Build

The commands below are **bash**. On a native Windows host that means Git Bash (or WSL), not
PowerShell — PowerShell has no `\` line continuation, so the multi-line `cp` below will not run
there as written. A PowerShell equivalent is given alongside step 2.

1. Build the main desktop NSIS installer from the repo root (sidecars first):

```bash
pnpm --filter desktop tauri -- build
```

A native Windows host writes `mausVoice_*-setup.exe` under
`apps/desktop/src-tauri/target/release/bundle/nsis/`. Two things move that path:

- `CARGO_TARGET_DIR` replaces `apps/desktop/src-tauri/target` **entirely** — CI sets it (on
  Windows: `D:\cargo`), so the literal path below matches nothing there.
- `--target x86_64-pc-windows-msvc` inserts the target triple _before_ `release`.

The copy step reads both from the environment so it stays correct under either.

The setup's welcome/finish sidebar art comes from `branding/mausvoice-sidebar-installerimg.png` and is converted to the NSIS bitmap automatically by `scripts/generate-windows-installer-sidebar.mjs` (see `branding/README.md`); there is nothing to copy manually.

2. Copy it into the bootstrapper:

```bash
# Set TARGET_TRIPLE only if you passed --target, e.g. TARGET_TRIPLE=x86_64-pc-windows-msvc
TARGET_TRIPLE="${TARGET_TRIPLE:-}"
TARGET_DIR="${CARGO_TARGET_DIR:-apps/desktop/src-tauri/target}"
nsis="$TARGET_DIR/$TARGET_TRIPLE/release/bundle/nsis"

# The glob also matches installers left by earlier builds, and `cp` with more than one
# source needs a *directory* destination -- so it would fail instead of embedding the
# installer you just built. Take the most recent one explicitly.
setup="$(ls -1t "$nsis"/mausVoice_*-setup.exe 2>/dev/null | head -n 1)"
[ -n "$setup" ] || { echo "no mausVoice_*-setup.exe under $nsis" >&2; exit 1; }
cp "$setup" apps/windows-installer/src-tauri/installer/mausVoice_Setup.exe
```

The same step in PowerShell, which uses backtick continuation:

```powershell
$TargetTriple = if ($env:TARGET_TRIPLE) { "$env:TARGET_TRIPLE/" } else { "" }
$TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { "apps/desktop/src-tauri/target" }
# Same hazard as the bash step above: the glob also matches installers left by
# earlier builds, and Copy-Item with more than one source needs a *directory*
# destination. Resolve it to the most recent one, and refuse to continue when
# there is none rather than embedding a stale installer.
$nsis = "$TargetDir/$TargetTriple/release/bundle/nsis"
$setup = Get-ChildItem "$nsis/mausVoice_*-setup.exe" |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw "no mausVoice_*-setup.exe under $nsis" }
Copy-Item $setup.FullName apps/windows-installer/src-tauri/installer/mausVoice_Setup.exe
```

3. Build the bootstrapper:

```bash
pnpm --filter @maus-inc/windows-installer tauri:build
```

Window is 480×320, non-resizable, always-on-top, undecorated (`src-tauri/tauri.conf.json`).

## CI

Use **pnpm** with the frozen lockfile, same as the rest of the monorepo. Do not `npm install` inside `apps/windows-installer`.

## Notes

- WebView2 uses Tauri's embedded bootstrapper.
- First-install UX only. This installer has no updater to check at all, and not because a
  field was left blank: its `src-tauri/tauri.conf.json` declares no `plugins` block, so
  there is no endpoint and no pubkey. The signed `latest.json` that `release.yml` publishes
  is the desktop app's manifest, gated fail-closed on the updater signing secrets, and it
  says nothing about this installer. Upgrading means installing a newer installer over the
  top.

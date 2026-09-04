# Installing the Cargo Toolchain for Kilo Code Bot Agents (Linux Sandbox)

This document captures the exact steps needed to get `cargo clippy` and
`cargo test` working inside a fresh Linux sandbox for the mausVoice Tauri
desktop application. It is written from direct experience installing in
a clean Ubuntu 22.04 container.

## Prerequisites

- Ubuntu 22.04 or compatible Debian-based distro
- Root or sudo access
- Internet access for package downloads and Cargo crate fetches

## Step 1: Install rustup and the stable toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain stable --profile minimal
```

The `-y` flag answers all prompts non-interactively. The `--profile minimal`
variant installs only `rustc`, `cargo`, and `rust-std` without extra
components. Source the cargo environment for the current shell:

```bash
source "$HOME/.cargo/env"
```

Verify:

```bash
rustc --version   # expect 1.98+ or current stable
cargo --version
```

## Step 2: Install required system libraries

The Tauri desktop build requires native development libraries. Install
them all at once:

```bash
apt-get update -qq
apt-get install -y -qq \
  build-essential \
  pkg-config \
  libssl-dev \
  libglib2.0-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libsoup-3.0-dev \
  libwebkit2gtk-4.1-dev \
  libasound2-dev \
  libpulse-dev \
  libudev-dev
```

Explanation of each package:

| Package | Why needed |
|---------|-----------|
| `build-essential` | C toolchain (`cc`, `make`) required by many `build.rs` scripts and for linking |
| `pkg-config` | Used by Rust crates to locate system library headers and linker flags |
| `libssl-dev` | `reqwest`/`rustls` TLS support when the `native-tls` or OpenSSL features are enabled |
| `libglib2.0-dev` | `glib-sys` / `gio-sys` — GLib is a transitive dependency of GTK and zbus |
| `libgtk-3-dev` | GTK 3 bindings used by the tray icon, window theming, and native menus |
| `libayatana-appindicator3-dev` | System tray / app indicator support on Linux |
| `librsvg2-dev` | SVG rendering for tray icons and image assets |
| `libsoup-3.0-dev` | `soup3-sys` — HTTP client support used by WebKit/webview |
| `libwebkit2gtk-4.1-dev` | WebKitGTK — the Tauri webview backend on Linux |
| `libasound2-dev` | `alsa-sys` — ALSA audio backend |
| `libpulse-dev` | PulseAudio audio bindings |
| `libudev-dev` | Device enumeration for input and audio hardware |

## Step 3: Install Clippy

```bash
rustup component add clippy
```

Verify:

```bash
cargo clippy --version
```

## Step 4: Configure Cargo to use the system git CLI

Some git dependencies (notably git-based crate dependencies pinned to a
specific revision) fail to fetch through `libgit2` inside restricted
sandboxes. Force Cargo to use the system `git` binary:

```bash
mkdir -p apps/desktop/src-tauri/.cargo
cat > apps/desktop/src-tauri/.cargo/config.toml << 'EOF'
[net]
git-fetch-with-cli = true
EOF
```

This file is picked up automatically when running `cargo` from within the
`apps/desktop/src-tauri` directory.

## Step 5: Run Clippy

```bash
cd apps/desktop/src-tauri
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo clippy -- -D warnings
```

The `TAURI_CONFIG` environment variable satisfies the Tauri build script
without requiring a full `tauri.conf.json` in the sandbox. The `-D warnings`
flag promotes all warnings to errors, matching CI behavior.

## Step 6: Run Tests

```bash
cd apps/desktop/src-tauri
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib
```

`--lib` avoids compiling the binary target, which requires additional
platform libraries not needed for unit-test coverage of the library code.

## Common Errors and Fixes

### `pkg-config exited with status code 1` for `glib-2.0`

**Cause:** `libglib2.0-dev` is not installed.

**Fix:**
```bash
apt-get install -y libglib2.0-dev
```

### `pkg-config exited with status code 1` for `libsoup-3.0`

**Cause:** `libsoup-3.0-dev` is not installed.

**Fix:**
```bash
apt-get install -y libsoup-3.0-dev libwebkit2gtk-4.1-dev
```

### `pkg-config exited with status code 1` for `alsa`

**Cause:** `libasound2-dev` is not installed.

**Fix:**
```bash
apt-get install -y libasound2-dev
```

### `rust-lld: error: unable to find library -lxdo`

**Cause:** Missing system library for the `xdo` crate (window focus/input
simulation). This is a transitive dependency of the desktop app.

**Fix:**
```bash
apt-get install -y libxdo-dev
```

If `libxdo-dev` is unavailable in the distro's repositories, check whether
the crate is behind a feature flag that can be disabled, or install from
source. In the mausVoice build, the `xdo` dependency is currently required
at link time.

### `could not read refs from remote repository` for git dependencies

**Cause:** `libgit2` fails to fetch a git-based dependency, usually due
to network restrictions in the sandbox.

**Fix:** Configure Cargo to use the system `git` binary as described in
Step 4.

### `warning: no default linker ('cc') was found`

**Cause:** The C compiler toolchain is missing.

**Fix:**
```bash
apt-get install -y build-essential
```

## Complete Installation Script

For a fresh sandbox, the following single script installs everything and
runs a verification check:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Installing rustup..."
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain stable --profile minimal
source "$HOME/.cargo/env"

echo "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  build-essential \
  pkg-config \
  libssl-dev \
  libglib2.0-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libsoup-3.0-dev \
  libwebkit2gtk-4.1-dev \
  libasound2-dev \
  libpulse-dev \
  libudev-dev \
  libxdo-dev

echo "Installing clippy..."
rustup component add clippy

echo "Configuring git fetch fallback..."
mkdir -p apps/desktop/src-tauri/.cargo
cat > apps/desktop/src-tauri/.cargo/config.toml << 'EOF'
[net]
git-fetch-with-cli = true
EOF

echo "Verifying installation..."
cd apps/desktop/src-tauri
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo clippy -- -D warnings
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib

echo "Toolchain ready."
```

## Verification Matrix

| Check | Command | Expected result |
|-------|---------|-----------------|
| Rust version | `rustc --version` | `rustc 1.98.0` or newer stable |
| Cargo version | `cargo --version` | `cargo 1.98.0` or newer |
| Clippy installed | `cargo clippy --version` | Prints clippy version without error |
| Clippy passes | `TAURI_CONFIG=... cargo clippy -- -D warnings` | `Finished dev profile [unoptimized + debuginfo] target(s)` |
| Library tests pass | `TAURI_CONFIG=... cargo test --lib` | All tests pass or `test result: ok` |
| Bindings regenerate | `pnpm gen:bindings` | `packages/desktop-native-apis/src/bindings.ts` updated without errors |

## Notes for Future Agents

- The sandbox has no `cc` linker by default. `build-essential` fixes this.
- The sandbox blocks some `libgit2` network fetches. The `.cargo/config.toml`
  workaround is mandatory for git-based dependencies.
- `libxdo-dev` is required for the `xdo` crate even though it is not an
  obvious Tauri dependency. If the build fails at link time with `-lxdo`,
  this is the missing package.
- `cargo test --lib` is preferred over `cargo test` in CI because the
  binary target pulls in additional platform libraries that are not needed
  for library unit tests.
- The `apps/desktop/.env.dev` file is referenced by the Tauri build but is
  not required for `cargo clippy` or `cargo test --lib`. Its absence
  produces a warning but does not fail the build.
- The `ferrous-focus` git dependency is fetched from GitHub and may fail
  transiently with `class=Net (12); code=Eof (-20)`. The `git-fetch-with-cli`
  workaround resolves this.

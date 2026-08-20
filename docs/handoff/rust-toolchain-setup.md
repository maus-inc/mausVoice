# Replicating the Rust Toolchain Setup (cloud / CI sandbox)

This note records how to get a working Rust toolchain in a fresh Linux
sandbox so the desktop app's `cargo fmt --check`, `cargo clippy -- -D warnings`,
and `cargo test` gates can actually run. It was written after setting up the
toolchain from scratch in a container that had only `node`, `pnpm`, `git`, and
`gh` preinstalled (no `cargo`, no C compiler).

## 1. Install Rust via rustup

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
sh /tmp/rustup-init.sh -y --default-toolchain stable --profile minimal
. "$HOME/.cargo/env"   # put cargo/rustc on PATH for this shell
```

`rustup` lands in `$HOME/.cargo`; source `$HOME/.cargo/env` (or add it to your
shell profile) in every new shell before running cargo commands.

The repo's `.nvmrc` pins Node 24 for the TypeScript side; the Rust side just
needs a current stable toolchain. The sandbox above resolved stable to
`1.88.0` and compiled the desktop crate fine.

## 2. Install a C toolchain + Tauri system libraries

`rustc` invokes a system linker (`cc`). Without it, even a trivial crate fails
at link time with `error: linker 'cc' not found`. The Tauri desktop crate also
links against the webview/GTK stack, so the following system packages are
required to compile `apps/desktop/src-tauri`:

```bash
sudo apt-get update
if apt-cache show libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
  webkit_pkg=libwebkit2gtk-4.1-dev
else
  webkit_pkg=libwebkit2gtk-4.0-dev
fi
sudo apt-get install -y \
  build-essential pkg-config cmake \
  libgtk-3-dev "$webkit_pkg" \
  libayatana-appindicator3-dev librsvg2-dev libasound2-dev \
  libunwind-dev libxdo-dev libgtk-layer-shell-dev
```

This is the minimal subset of `.github/scripts/install-desktop-linux-deps.sh`
needed to *compile and unit-test* the Rust code. The full script also pulls
AppImage/rpm/gstreamer/wtype tooling for bundling a release artifact; those are
not required to run the `cargo` gates and are omitted here to keep the install
fast. If you later need a full `tauri build`, run the full script instead.

> Run as root in the sandbox (no `sudo` binary present) — `apt-get` works
> directly. On a normal dev machine prefix the `apt-get` calls with `sudo`.

## 3. Verify

```bash
. "$HOME/.cargo/env"
cargo --version          # e.g. cargo 1.88.0
cc --version             # GNU C compiler, from build-essential
```

Then, from `apps/desktop/src-tauri`:

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test               # or: cargo test system::audio_feedback
```

## 4. Notes / gotchas

- The `cargo clippy` job in CI sets `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`
  (working directory `apps/desktop/src-tauri`) to avoid needing the signed
  native sidecar binaries at lint time. Use the same env var if clippy complains
  about missing external binaries.
- First build of the desktop crate is large (tauri + tokio + serde + webkit
  bindings). Expect a long initial compile; subsequent runs are cached by
  `rust-cache` in CI and by `~/.cargo` locally.
- `cargo test` runs tests on parallel threads and `audio_feedback`'s thock
  limiter mutates a process-global `static`; the tests reset that static at the
  start of each test (see `apps/desktop/src-tauri/src/system/audio_feedback.rs`)
  so they do not interfere. Run with `--test-threads=1` if you ever see flakiness.

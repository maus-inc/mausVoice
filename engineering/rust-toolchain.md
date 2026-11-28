# Rust toolchain in agent sandboxes

This guide applies when a Linux x86-64 sandbox cannot reach upstream Rust, crate, Debian, or GitHub Release hosts. It is not a property of the repository, CI, or an unrestricted developer machine. On a host that reaches upstream hosts directly, install `rustup` normally and run the gates directly; read this file only for the `$CARGO_HOME` and `CARGO_BUILD_JOBS` notes.

Probe before assuming the environment is restricted: run `command -v cargo`, `cargo --version`, and `curl -m 8 -o /dev/null -w '%{http_code}'` against `https://sh.rustup.rs`, `https://static.rust-lang.org`, and `https://index.crates.io`. Three `200` responses mean upstream installation works directly.

When a sandbox blocks `sh.rustup.rs`, `static.rust-lang.org`, `crates.io`, `huggingface.co`, Debian mirrors, or GitHub Release redirects (`objects.githubusercontent.com` and `release-assets.githubusercontent.com`), `apt-get update` fails and any `build.rs` that downloads a release tarball fails at link time. Use `vendor/sandbox-toolchain` instead.

This repository has seven Rust workspaces:

| Workspace                          | Cargo.lock | Notes                                       |
| ---------------------------------- | ---------- | ------------------------------------------- |
| `apps/desktop/src-tauri`           | yes        | main Tauri app                              |
| `apps/windows-installer/src-tauri` | yes        | Windows installer, not gated on Linux       |
| `packages/rust_transcription`      | yes        | whisper.cpp plus ONNX transcription sidecar |
| `packages/rust_gtk_pill`           | yes        | Linux pill overlay, requires a display      |
| `packages/rust_macos_pill`         | yes        | macOS pill overlay, fmt only on Linux       |
| `packages/rust_windows_pill`       | yes        | Windows pill overlay, fmt only on Linux     |
| `packages/rust_pill_shared`        | yes        | shared pill logic                           |

`rust-toolchain.toml` pins `channel = "1.88.0"` with the `clippy` and `rustfmt` components. Newer stable toolchains fail `cargo clippy -- -D warnings` and `cargo test --lib` on the desktop crate. No `Cargo.toml` in the tree declares a `rust-version` floor above 1.88.0, so never pass `--ignore-rust-version` or bump the pin for sandbox convenience.

## Source 1, the vendor branch

The orphan branch `vendor/sandbox-toolchain` on `maus-inc/mausVoice` carries the Rust 1.88.0 components, cross-target `rust-std` archives (`x86_64-pc-windows-msvc` and `aarch64-apple-darwin`), the vendored Cargo crate tree for all seven workspaces, a Debian 12 development sysroot for Tauri and GTK, required CLI tools (`pkg-config`, `cmake`, `patchelf`, `file`), native `build.rs` archives, and non-Rust sandbox tooling. See `engineering/sandbox-vendored-toolchain.md` for the full lookup table and safe `/tmp` fetch commands.

Download the tarball via `codeload.github.com` into `/tmp`, reassemble `.part-*` files preserving executable bits, verify `sha256sum -c MANIFEST.sha256`, and follow `FETCH.md` on the branch. Exact versions, digests, and gate verification records live in `README.md` and `FETCH.md` on `vendor/sandbox-toolchain`.

Standard Rust gates supported by the vendored payload:

| Gate                | Command                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Toolchain           | `rustc --version`, `cargo --version`, `cargo clippy --version`, `cargo fmt --version`                   |
| Offline resolve     | `CARGO_NET_OFFLINE=true cargo metadata --locked` across all seven manifests                             |
| Path patches        | `cargo tree -i block`, `-i sherpa-onnx-sys`, `-i rdev` resolve from `patches/`                          |
| Format              | `cargo fmt --check` in the six Linux-formatted crates                                                   |
| Clippy              | `cargo clippy --locked -- -D warnings` in `apps/desktop/src-tauri` and `packages/rust_pill_shared`      |
| Desktop tests       | `CARGO_BUILD_JOBS=1 cargo test --locked --lib` in `apps/desktop/src-tauri`                              |
| Transcription tests | `CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --lib`   |
| Pill shared tests   | `cargo test --locked --manifest-path packages/rust_pill_shared/Cargo.toml`                              |
| GTK pill tests      | `xvfb-run -a cargo test --locked --manifest-path packages/rust_gtk_pill/Cargo.toml`                     |
| Sidecar integration | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --test sidecar_integration` |
| Cross-target check  | `cargo check --locked --target x86_64-pc-windows-msvc` and `--target aarch64-apple-darwin`              |

The six formatted crates are `apps/desktop/src-tauri`, `packages/rust_pill_shared`, `packages/rust_gtk_pill`, `packages/rust_macos_pill`, `packages/rust_windows_pill`, and `packages/rust_transcription`. `apps/windows-installer/src-tauri` is excluded from that loop. `cargo fmt --check` does not resolve dependencies, so it can run with only a `rustfmt` binary.

## Source 2, npm, format only

`registry.npmjs.org` is reachable and the `@rustbin/*` packages publish rustc, cargo,
rustfmt and clippy. They top out at 1.88.0, which is exactly this repo's pin, so the
version is sufficient here. Resolution is still the blocker: cargo cannot reach
`crates.io`, so `cargo clippy` and `cargo test` cannot run from this source no matter
which toolchain version it provides. Use it to run `cargo fmt --check` when the vendor
branch is not available, and say so in the PR body.

Install into a prefix under `/tmp` and never into the repo:

```bash
mkdir -p /tmp/rust-tools && cd /tmp/rust-tools
npm init -y >/dev/null
npm install --no-save --ignore-scripts \
  @rustbin/rustc@1.88.0 @rustbin/cargo@1.88.0 @rustbin/rustfmt@1.88.0
```

Keep the two sources in separate prefixes. The vendor branch runs each component's own
`install.sh`, which puts binaries flat in `$PREFIX/bin`. An npm install nests them
under `node_modules/@rustbin/*/bin`. Point one source's environment at the other's
directory and the tools are simply not found. Pick one source per shell.

## Offline cargo environment

```bash
export SV=/tmp/mausvoice-toolchain        # the payload root FETCH.md prints
export CARGO_HOME="$SV/cargo-home"        # holds the config.toml with the source replacement
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="$SV/cargo-target" # keeps a multi-gigabyte target dir out of the workspace
export PKG_CONFIG="$SV/tools/bin/pkg-config"
export PKG_CONFIG_PATH="$SV/gtk-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig"
export LIBCLANG_PATH="$SV/gtk-sysroot/usr/lib/llvm-14/lib"

cd apps/desktop/src-tauri && cargo clippy --locked -- -D warnings
CARGO_BUILD_JOBS=1 cargo test --locked --lib
```

Read the real paths out of `FETCH.md` rather than trusting the names above. The branch
ships its own `rust/cargo-config.toml` with three stanzas, including the replacement
for the `ferrous-focus` git dependency, and `directory = "/tmp/cargo-vendor"`.

- `CARGO_BUILD_JOBS=1` is required for `cargo test` in the Arena agent sandbox. Parallel
  linking peaks above the 3,939 MB it has, and the linker dies with `signal 9`. CI does
  not set it, and the hosted runners have the memory to link in parallel.
- `cargo --config <path> clippy` does not work. Cargo does not forward the global
  `--config` flag to external subcommands, so clippy resolves against crates.io and
  fails. Built-in commands such as `metadata` and `check` do honour the flag. Put the
  replacement in `$CARGO_HOME/config.toml` instead.
- `packages/rust_gtk_pill` opens a display. Run it under `xvfb-run -a`; the sysroot
  group ships `xvfb`, `xauth` and `xserver-common`.
- `cmake` must be on `PATH` before any build of `packages/rust_transcription`, because
  its `build.rs` shells out to it. The tools group ships `cmake` 3.25.1.

## Native payloads

Two `build.rs` scripts download release archives that the Arena agent sandbox cannot
reach. The vendor branch pre-seeds both under `native/`, and the digests in its
`MANIFEST.sha256` match the pins in the build scripts byte for byte.

| Payload             | File                                               | Env var that selects it                                                                  |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ONNX Runtime 1.23.2 | `onnxruntime-linux-x64-1.23.2.tgz`                 | `MAUSVOICE_ORT_DYLIB_PATH`, then `ORT_DYLIB_PATH`. Must point at a file, not a directory |
| sherpa-onnx 1.13.5  | `sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2` | `SHERPA_ONNX_ARCHIVE_DIR`                                                                |

For sherpa the precedence is `DOCS_RS=1`, then `SHERPA_ONNX_LIB_DIR`, then
`SHERPA_ONNX_ARCHIVE_DIR`. Do not use `DOCS_RS=1`, it skips linking and produces a
crate that cannot run. `SHERPA_ONNX_LIB_DIR` bypasses the digest check. Use
`SHERPA_ONNX_ARCHIVE_DIR` and let the build script verify the archive it expects.
Pre-seeding only the extracted directory does not work, so pre-seed the archive.

The `#[ignore]` tests in `packages/rust_transcription/tests/sidecar_integration.rs` load real models. `vendor/sandbox-toolchain` ships Whisper `ggml-tiny.bin`, Whisper `ggml-base.bin`, and the SenseVoice ONNX bundle under `models/`. Copy them to a `/tmp` directory and export `RUST_TRANSCRIPTION_MODELS_DIR` (following `FETCH.md` on the branch) to run those tests offline. Whisper weights also honor `RUST_TRANSCRIPTION_MODEL_URL_<UPPERCASE_ID>`. Only the Parakeet CTC, Parakeet TDT, and Canary 1B bundles remain unvendored (gap G10 in `engineering/sandbox-coverage-gaps.md`); report G10 for those unvendored bundles rather than claiming all ignored sidecar tests are blocked.

## Do not repeat these mistakes

- Do not add a Rust toolchain as a project dependency. It edits `package.json` and `pnpm-lock.yaml` for no reason. This repo has no root `test:rust` script and does not need one.
- Do not run rustfmt across every `**/*.rs` file in one pass. The tree is already formatted, and a repo-wide reformat is an unrelated change that needs a decision.
- Do not treat `echo "Exit code: $?"` after a pipe as the cargo result. A pipe such as `cargo ... | head` hides the real exit code. Redirect to a file and check `$?`.
- Do not run `git fetch origin vendor/sandbox-toolchain` inside the repository checkout, and do not set `CARGO_HOME`, `CARGO_TARGET_DIR`, `RUSTUP_HOME`, or the extracted payload inside `/home/user`. Everything under the workspace root is snapshotted against a cap. Fetch via `codeload.github.com` and keep all of it in `/tmp`.
- Do not commit a `.cargo/config.toml` into the repo. The vendored replacement is sandbox plumbing and would break a normal `cargo build` for every other contributor.
- Do not copy `cargo-fmt` into the cargo bin directory. Both `cargo-fmt` and `cargo-clippy` are already on `PATH` once the toolchain `bin/` is.
- Do not claim any Rust gate is unrunnable before checking `engineering/sandbox-vendored-toolchain.md` and `vendor/sandbox-toolchain`.

Detail, provenance, and setup steps live on `vendor/sandbox-toolchain` in `README.md` and `FETCH.md`. The build specification for that payload is `docs/sandbox-toolchain-vendor-spec.md`.

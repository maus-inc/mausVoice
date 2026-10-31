# Rust toolchain in agent sandboxes

A restricted sandbox reaches `github.com`, `codeload.github.com`, `api.github.com`,
`registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`. It cannot reach
`sh.rustup.rs`, `static.rust-lang.org`, `crates.io`, `index.crates.io`,
`static.crates.io` or `huggingface.co`. `apt-get update` fails against every Debian
mirror, so no system package can be installed even though `sudo` works. GitHub Release
assets redirect to `objects.githubusercontent.com`, which is also blocked, so a
`build.rs` that downloads a release tarball fails at link time.

This repository has seven Rust workspaces, not one:

| Workspace                          | Cargo.lock | Notes                                       |
| ---------------------------------- | ---------- | ------------------------------------------- |
| `apps/desktop/src-tauri`           | yes        | the main Tauri app, 906 packages            |
| `apps/windows-installer/src-tauri` | yes        | 497 packages, not gated on Linux            |
| `packages/rust_transcription`      | yes        | 314 packages, whisper.cpp plus ONNX sidecar |
| `packages/rust_gtk_pill`           | yes        | 90 packages, needs a display                |
| `packages/rust_macos_pill`         | yes        | 27 packages, fmt only on Linux              |
| `packages/rust_windows_pill`       | yes        | 24 packages, fmt only on Linux              |
| `packages/rust_pill_shared`        | yes        | 1 package, shared pill logic                |

`rust-toolchain.toml` pins `channel = "1.88.0"` with the `clippy` and `rustfmt`
components. The file records why: newer stable started failing
`cargo clippy -- -D warnings` and `cargo test --lib` with exit 101 on the desktop
crate. None of the seven `Cargo.lock` files and no `Cargo.toml` in the tree carries a
`rust-version` field, so nothing in this repo needs a toolchain above 1.88.0. Do not
bump the pin to chase an upstream MSRV the way another project had to.

## Source 1, the vendor branch

The orphan branch `vendor/sandbox-toolchain` on `maus-inc/mausVoice` carries the Rust
1.88.0 components, the cargo dependency tree for all seven workspaces, a Debian 12
development sysroot for the Tauri and GTK stack, the missing command line tools, and
the two native archives the `build.rs` scripts would otherwise download.

Fetch it, extract it under `/tmp`, and follow its `FETCH.md`. It is the only
instruction file you need. Commit `61fb32959d6ac6a36b0c6356069a767ee7725caa`,
3870 files, no parents, nothing merged into `main`.

Measured with that payload, as recorded in the branch `README.md`:

| Gate                | Command                                                                                                 | Result                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Toolchain           | `rustc`, `cargo`, `cargo clippy`, `cargo fmt` `--version`                                               | 1.88.0 / 1.88.0 / 0.1.88 / 1.8.0-stable |
| Offline resolve     | `CARGO_NET_OFFLINE=true cargo metadata --locked`, all seven manifests                                   | 7 of 7 exit 0                           |
| Path patches        | `cargo tree -i block`, `-i sherpa-onnx-sys`, `-i rdev`                                                  | all three resolve from `/src/patches/`  |
| Format              | `cargo fmt --check` in six crates                                                                       | 6 of 6 pass                             |
| Clippy              | `cargo clippy --locked -- -D warnings` in `apps/desktop/src-tauri`                                      | 0 warnings, 6m 13s                      |
| Desktop tests       | `cargo test --locked --lib`                                                                             | 363 passed, 0 failed, 1 ignored         |
| Transcription tests | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --lib`                      | 64 passed, 0 failed, 1 ignored          |
| pill_shared tests   | `cargo test --locked --manifest-path packages/rust_pill_shared/Cargo.toml`                              | 242 passed, 0 failed                    |
| GTK pill tests      | `xvfb-run -a cargo test --locked --manifest-path packages/rust_gtk_pill/Cargo.toml`                     | 42 passed, 0 failed                     |
| Sidecar integration | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --test sidecar_integration` | 7 passed, 0 failed, 4 ignored           |

The six fmt crates are `apps/desktop/src-tauri`, `packages/rust_pill_shared`,
`packages/rust_gtk_pill`, `packages/rust_macos_pill`, `packages/rust_windows_pill`
and `packages/rust_transcription`. `apps/windows-installer/src-tauri` is not in that
loop. `cargo fmt --check` does not resolve dependencies, so it is the one gate that
survives without the vendor branch, provided a rustfmt binary exists.

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

- `CARGO_BUILD_JOBS=1` is required for `cargo test`. Parallel linking peaks above the
  memory a sandbox has and the linker dies with `signal 9`. CI sets it too.
- `cargo --config <path> clippy` does not work. Cargo does not forward the global
  `--config` flag to external subcommands, so clippy resolves against crates.io and
  fails. Built-in commands such as `metadata` and `check` do honour the flag. Put the
  replacement in `$CARGO_HOME/config.toml` instead.
- `packages/rust_gtk_pill` opens a display. Run it under `xvfb-run -a`; the sysroot
  group ships `xvfb`, `xauth` and `xserver-common`.
- `cmake` must be on `PATH` before any build of `packages/rust_transcription`, because
  its `build.rs` shells out to it. The tools group ships `cmake` 3.25.1.

## Native payloads

Two `build.rs` scripts download release archives that a sandbox cannot reach. The
vendor branch pre-seeds both under `native/`, and the digests in its
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

The `--ignored` tests in `packages/rust_transcription/tests/sidecar_integration.rs`
download models from `huggingface.co`, which is not reachable. They cannot run in a
sandbox. Say so in the PR body instead of reporting them as passed.

## Do not repeat these mistakes

- Do not add a Rust toolchain as a project dependency. It edits `package.json` and
  `pnpm-lock.yaml` for no reason. This repo has no root `test:rust` script and does
  not need one.
- Do not run rustfmt across every `**/*.rs` file in one pass. The tree is already
  formatted, and a repo-wide reformat is an unrelated change that needs a decision.
- Do not treat `echo "Exit code: $?"` after a pipe as the cargo result. A pipe such as
  `cargo ... | head` hides the real exit code. Redirect to a file and check `$?`.
- Do not set `CARGO_HOME`, `CARGO_TARGET_DIR`, `RUSTUP_HOME` or the extracted payload
  inside `/home/user`. Everything under the workspace root is snapshotted against a
  cap. Keep all of it in `/tmp`.
- Do not commit a `.cargo/config.toml` into the repo. The vendored replacement is
  sandbox plumbing and would break a normal `cargo build` for every other contributor.
- Do not copy `cargo-fmt` into the cargo bin directory. Both `cargo-fmt` and
  `cargo-clippy` are already on `PATH` once the toolchain `bin/` is.
- Do not claim a Rust gate is unrunnable before fetching the vendor branch. Every gate
  in the table above has run against this repository.

Detail, provenance and the full gate matrix live on the branch in `README.md` and
`FETCH.md`. The build specification for that payload is
`docs/sandbox-toolchain-vendor-spec.md`.

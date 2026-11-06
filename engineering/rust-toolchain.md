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

Those counts describe the payload's own `README.md` at the commit it was built from. The
tree has grown since, so treat the table as a floor and read the line `cargo test` prints
as the current result. Measured on this tree on 2026-11-06, the desktop library reports
`580 passed, 0 failed, 35 ignored`.

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

## Environment facts worth not rediscovering

Measured against the payload at `vendor/sandbox-toolchain` tip `8442ae0`:

- `sha256sum -c MANIFEST.sha256` reports 14441 of 14442 files OK. The one miss is
  `README.md`: the branch amended its own README after generating the manifest. Every
  payload artifact verifies, so treat that single line as expected and check the count
  rather than the exit status.
- The payload does not ship `xvfb-run`, but the sysroot does ship
  `$SV/gtk-sysroot/usr/bin/Xvfb`. `packages/rust_gtk_pill` passes headless without
  either (44 tests), so do not report the suite as unrunnable for want of a display.
- Linking a test binary against the sysroot's `libpulse.so` fails with `undefined
reference to pa_*` because `libpulsecommon-16.1.so` lives in
  `$SV/gtk-sysroot/usr/lib/x86_64-linux-gnu/pulseaudio/`, which is not on the link
  path. A `cc` wrapper earlier on `PATH` that appends `-Wl,--allow-shlib-undefined`
  fixes it without changing `RUSTFLAGS`, so the incremental cache survives. Add the
  `pulseaudio` directory to `LD_LIBRARY_PATH` for the run.
- `apps/desktop/src-tauri` builds a cdylib, and linking it needs several gigabytes.
  The sysroot, the crate tree and a warm target directory together sit around 12 GB, so
  a 20 GB sandbox has to drop the reassembled archives and `.part-*` pieces after
  extraction. A `No space left on device` in `final link failed` is that, not a code
  failure.

## Running the ignored ALSA fault-injection tests

`apps/desktop/src-tauri` carries 32 `#[ignore]`d ALSA tests that drive the recorder's
fault paths: failed open, failed start, failed stop, failed pause and resume, uncertain
close, disconnect, XRUN, short read, short write, stale poll, zero read and stalled read.
They are not unrunnable in a sandbox. `tests/fixtures/*.c` are `LD_PRELOAD` shims over
`dlsym(RTLD_NEXT, "snd_pcm_readi")` and friends, so they build with the host compilers and
no ALSA headers:

```bash
mkdir -p /tmp/alsa-fixtures
for f in apps/desktop/src-tauri/tests/fixtures/*.c; do
  gcc -shared -fPIC -O1 -o "/tmp/alsa-fixtures/$(basename "$f" .c).so" "$f" -ldl
done
```

`null` is a built-in ALSA PCM, so a two-line config is enough even though the payload
ships no `alsa-lib` plugin modules:

```bash
cat > /tmp/maus-alsa/alsa.conf <<'EOF'
pcm.!default { type null }
ctl.!default { type hw card 0 }
EOF
```

Run one test against the built test binary. `ALSA_CONFIG_PATH` makes the null device the
default input; `LD_PRELOAD` supplies the fault; the `pulseaudio` directory is required
because the binary links `libpulse.so`, which needs `libpulsecommon-16.1.so`:

```bash
BIN=/tmp/cargo-target/debug/deps/desktop_lib-<hash>
SYS=/tmp/vendor-payload/system
ALSA_CONFIG_PATH=/tmp/maus-alsa/alsa.conf \
LD_LIBRARY_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu/pulseaudio:/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu \
LD_PRELOAD=/tmp/alsa-fixtures/alsa_short_read.so \
  "$BIN" --exact platform::audio::cpal_impl::tests::cpal_alsa_delivers_only_frames_returned_by_a_short_read --ignored
```

The fixture and environment variable each test needs, read from its body:

| Test                                                              | Fixture                    | Env                               |
| ----------------------------------------------------------------- | -------------------------- | --------------------------------- |
| `cpal_alsa_build_failure_distinguishes_confirmed_close`           | `alsa_build_failure`       |                                   |
| `cpal_alsa_uncertain_build_close_blocks_successor_capture`        | `alsa_build_failure`       |                                   |
| `cpal_alsa_uncertain_cached_build_close_blocks_successor_capture` | `alsa_build_failure`       |                                   |
| `cpal_alsa_capture_build_waits_for_probe_close`                   | `alsa_probe_close_failure` |                                   |
| `cpal_alsa_uncertain_probe_blocks_successor_capture`              | `alsa_probe_close_failure` |                                   |
| `cpal_alsa_discovery_during_recording_leaves_capture_running`     | `alsa_probe_close_failure` |                                   |
| `cpal_alsa_capture_disconnect_stops_worker`                       | `alsa_disconnect`          |                                   |
| `cpal_alsa_disconnect_preserves_incomplete_recording`             | `alsa_disconnect`          |                                   |
| `cpal_alsa_capture_disconnected_state_stops_worker`               | `alsa_disconnect`          | `MAUS_TEST_DISCONNECTED_STATE=1`  |
| `cpal_alsa_failed_close_never_reuses_the_uncertain_handle`        | `alsa_close_failure`       |                                   |
| `cpal_alsa_failed_pause_marks_partial_capture`                    | `alsa_pause_failure`       |                                   |
| `cpal_alsa_failed_resume_marks_partial_capture`                   | `alsa_pause_failure`       |                                   |
| `cpal_alsa_unsupported_pause_keeps_recording`                     | `alsa_pause_failure`       |                                   |
| `cpal_alsa_failed_start_retains_an_uncertain_active_device`       | `alsa_start_failure`       |                                   |
| `cpal_alsa_failed_stop_retains_ownership_until_retry_succeeds`    | `alsa_stop_failure`        |                                   |
| `cpal_alsa_uncertain_probe_open_blocks_capture`                   | `alsa_open_failure`        |                                   |
| `cpal_alsa_uncertain_stream_open_blocks_capture`                  | `alsa_open_failure`        |                                   |
| `cpal_alsa_overrun_marks_the_captured_prefix_incomplete`          | `alsa_xrun`                |                                   |
| `cpal_alsa_pollerr_overrun_is_reported_and_prepared`              | `alsa_poll_xrun`           |                                   |
| `cpal_alsa_read_overrun_restarts_and_reports_loss`                | `alsa_read_xrun`           |                                   |
| `cpal_alsa_stale_poll_xrun_does_not_restart_after_resume`         | `alsa_stale_poll`          |                                   |
| `cpal_alsa_delivers_only_frames_returned_by_a_short_read`         | `alsa_short_read`          |                                   |
| `cpal_alsa_stalled_read_is_interruptible`                         | `alsa_short_read`          | `MAUS_TEST_READ_STALL=eagain`     |
| `cpal_alsa_zero_read_is_interruptible`                            | `alsa_short_read`          | `MAUS_TEST_READ_STALL=zero`       |
| `cpal_alsa_partial_playback_preserves_unwritten_frames`           | `alsa_short_write`         |                                   |
| `cpal_alsa_playback_recovers_xrun_after_partial_write`            | `alsa_short_write`         | `MAUS_TEST_WRITE_XRUN=1`          |
| `cpal_alsa_playback_drop_interrupts_retry`                        | `alsa_short_write`         | `MAUS_TEST_WRITE_ALWAYS_EAGAIN=1` |
| `cpal_alsa_playback_coalesces_persistent_errors`                  | `alsa_short_write`         | `MAUS_TEST_WRITE_FATAL=1`         |
| `cpal_alsa_pause_drains_a_read_before_its_callback`               | `alsa_delayed_callback`    |                                   |
| `cpal_alsa_input_waits_for_play_and_can_be_dropped_unstarted`     | none                       |                                   |
| `cpal_alsa_pause_suppresses_samples_until_resume`                 | none                       |                                   |
| `cpal_alsa_playback_uses_aligned_sample_buffers`                  | none                       |                                   |
| `cpal_worker_captures_and_hands_off_on_an_alsa_null_device`       | none                       |                                   |

Measured 2026-11-06 on the payload tip: 32 of 32 pass. The two playback tests are easy to
mix up, because both read like "stall": `playback_drop_interrupts_retry` wants the
permanent-EAGAIN build and `playback_coalesces_persistent_errors` wants the fatal-write
build, and swapping them fails on the error-callback count rather than on a timeout.

`linux::audio::tests::pulse_null_source_capture` is the one ignored test that still
cannot run: it needs a PulseAudio daemon, and the payload ships only the client libraries.

- `pnpm gen:bindings` (and `scripts/check-bindings.sh`) shells out to
  `cargo run --example gen_bindings`, which links the desktop cdylib. On a disk without
  room for a 1.6 GB `.a` plus a 1.6 GB `.so`, run it as
  `CARGO_PROFILE_DEV_DEBUG=0 bash scripts/bindings.sh`: the stripped build links in about
  ten minutes and regenerates `bindings.ts` byte for byte. Set it in the environment, not
  in `Cargo.toml`, and expect the next plain `cargo test` to rebuild the profile.

## Do not repeat these mistakes

- Do not run `git checkout -- <path>` to undo a scratch edit. This branch carries
  hundreds of uncommitted files, several of them rewritten relative to the base commit,
  so restoring one path silently discards real work: doing it to
  `apps/desktop/src-tauri/src/db/hotkey_queries.rs` deleted the whole
  `replace_dictation_language_hotkeys` implementation and its snapshot verification,
  and the tree stopped compiling against `commands.rs`. Edit the block back instead, or
  copy the file aside first.

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

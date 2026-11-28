# Vendored sandbox toolchain

The orphan branch `vendor/sandbox-toolchain` on `maus-inc/mausVoice` supplies the compilers, crate trees, system libraries, browsers, drivers, scanners, models, and CLI tools that a network-restricted Linux x86-64 sandbox cannot download from upstream hosts.

Use this page as the lookup index whenever a required tool, browser, scanner, driver, model, or crate registry is missing on the host. Check `vendor/sandbox-toolchain` before reporting any repository gate as unavailable, whether the task touches Rust, TypeScript, UI, or security workflows.

On a host that reaches upstream package mirrors, crate registries, and release hosts directly, install tooling the normal way and ignore the vendored payload. Probe the host before assuming either case.

## Authoritative files on the branch

Exact artifact versions, file sizes, SHA-256 digests, package lists, and shell setup steps live on `vendor/sandbox-toolchain` itself. Read them from the branch rather than relying on copied numbers:

1. `FETCH.md` on `vendor/sandbox-toolchain`. Complete setup procedure from download and verification through every optional tool group.
2. `README.md` on `vendor/sandbox-toolchain`. Directory layout, group index, and measured payload sizes.
3. `MANIFEST.sha256` on `vendor/sandbox-toolchain`. SHA-256 digest for every file, split part, and reassembled archive.
4. `system/PKGS.txt` on `vendor/sandbox-toolchain`. Complete list of Debian packages packed into the sysroot and tools tree.

Other repository documents for specific slices:

- `engineering/rust-toolchain.md`. Offline Cargo configuration, per-crate commands, native archive variables, and memory limits.
- `engineering/sandbox-coverage-gaps.md`. Repository gates that the payload still cannot close, accepted environment limits, and the closed-gap index.
- `engineering/sandbox-capability-gaps.md`. General development tools not in the payload and permanent sandbox constraints.
- `docs/sandbox-toolchain-vendor-spec.md` and `engineering/sandbox-vendor-handoff-prompt.md`. Specification and rebuild procedure when lockfiles, pins, or sysroot links change.

## Gate and task lookup

Before marking any gate `not run` in a restricted Linux x86-64 sandbox, locate the required tool in the table below and follow the matching step in `FETCH.md` on `vendor/sandbox-toolchain`.

| Gate or task                                                                                                                | Required tooling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Branch path                                                                                                                                      | Wiring notes                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live secret-scan self-test (`pnpm run test:secret-scan`) and commit-range scan                                              | `gitleaks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `system/tools/bin/gitleaks`                                                                                                                      | Standalone static binary. `scripts/ci/test-secret-history-scan.mjs` checks only `/usr/local/bin/gitleaks`, `/usr/bin/gitleaks`, and `/opt/homebrew/bin/gitleaks` rather than `PATH`. Install the verified binary at `/usr/local/bin/gitleaks` to run Phase 2 live.                                                                           |
| Headless browser screenshots and visual verification (`docs/visual-verification/README.md`, `scripts/verify/`, `stageshow`) | `chromium`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `system/tools/bin/chromium` (`system/tools/lib/chromium/chromium.part-*`)                                                                        | Reassemble `.part-*` files with executable mode preserved. `node scripts/verify/install-chromium.mjs --dir /tmp/chr` is a smaller standalone alternative when npm is reachable and no other vendored tools are needed.                                                                                                                       |
| UI video/GIF capture and OCR checks (`.agents/skills/ui-capture/SKILL.md`)                                                  | `ffmpeg`, `ffprobe`, `gifsicle`, `tesseract`, `chromium`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `system/tools/bin/` and `system/tools/share/tessdata/`                                                                                           | Put `system/tools/bin` on `PATH` and set `TESSDATA_PREFIX=<vendor>/system/tools/share/tessdata`.                                                                                                                                                                                                                                             |
| Desktop WebDriver suite (`pnpm --filter desktop test:webdriver`)                                                            | `tauri-driver`, `chromedriver`, `WebKitWebDriver`, debug desktop binary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `drivers/tauri-driver/`, `drivers/chromedriver-*/`, sysroot `usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebDriver`                            | Add `drivers/tauri-driver` and `drivers/chromedriver-*` to `PATH`, extract the Debian sysroot, build the desktop debug binary with the vendored Rust toolchain, and run under `xvfb-run`.                                                                                                                                                    |
| Rust fmt, clippy, and unit tests (`apps/desktop/src-tauri`, `packages/rust_*`)                                              | Rust 1.88.0 (`rustc`, `cargo`, `clippy`, `rustfmt`), vendored crates, Debian 12 dev sysroot, `pkg-config`, `cmake`, `patchelf`, `file`, `xvfb-run`                                                                                                                                                                                                                                                                                                                                                                                                                                   | `rust/toolchain/`, `rust/cargo-vendor.tar.xz.part-*`, `rust/cargo-config.toml`, `system/debian12-dev-sysroot.tar.xz.part-*`, `system/tools/bin/` | Set `CARGO_HOME` outside the repo, `CARGO_NET_OFFLINE=true`, `CARGO_BUILD_JOBS=1` for `cargo test`, `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`, and `PKG_CONFIG_*` plus `LIBCLANG_PATH` per `FETCH.md`.                                                                                                                                  |
| Cross-target Rust `cargo check` for `#[cfg(windows)]` and `#[cfg(target_os = "macos")]`                                     | `rust-std` for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `rust/targets/`                                                                                                                                  | Unpack into `$RUST_PREFIX/lib/rustlib/` per `FETCH.md`. Checks compile-time syntax and types; linking and runtime tests stay on CI runners.                                                                                                                                                                                                  |
| Transcription native `build.rs` archives (`packages/rust_transcription`)                                                    | ONNX Runtime dylib, sherpa-onnx static archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `native/onnxruntime/`, `native/sherpa-onnx/`                                                                                                     | Set `MAUSVOICE_ORT_DYLIB_PATH` to the extracted `libonnxruntime.so` file and `SHERPA_ONNX_ARCHIVE_DIR` to the archive directory so digest verification remains active.                                                                                                                                                                       |
| Real-model sidecar tests (`packages/rust_transcription/tests/sidecar_integration.rs`)                                       | Whisper `ggml-tiny.bin`, `ggml-base.bin`, SenseVoice ONNX                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `models/whisper/`, `models/onnx/sense-voice/`                                                                                                    | Copy to a `/tmp` models root and set `RUST_TRANSCRIPTION_MODELS_DIR`. Parakeet CTC, Parakeet TDT, and Canary 1B are not vendored (see gap G10 in `engineering/sandbox-coverage-gaps.md`).                                                                                                                                                    |
| General CLI, build, debugging, database, shell, cross-compile, supply-chain, runtime, and doc tools                         | `clang-14`, GNU binutils, `gdb`, `lldb`, `strace`, `ltrace`, `valgrind`, `perf`, `hyperfine`, `heaptrack`, `ninja`, `meson`, autotools, `sqlite3`, `psql`, `mariadb`, `redis-cli`, `shellcheck`, `shfmt`, `gpg`, `git-lfs`, `zstd`, `brotli`, `7z`, `dig`, `tcpdump`, `mtr`, `x86_64-w64-mingw32-gcc`, `aarch64-linux-gnu-gcc`, `qemu-aarch64-static`, `trivy`, `syft`, `grype`, `osv-scanner`, `fontconfig` and fonts, `tzdata`, `locales`, OpenJDK, Ruby, CPython, Perl, `pandoc`, `asciidoctor`, `plantuml`, `potrace`, `exiftool`, `binwalk`, `xdotool`, `scrot`, `osslsigncode` | `system/tools/`                                                                                                                                  | Self-locating binaries and `$ORIGIN/../lib` rpaths live under `system/tools/bin`. Follow `FETCH.md` for tools that need explicit variables or FHS support files (`gdb --data-directory`, `VALGRIND_LIB` and `libc6-dbg`, `TESSDATA_PREFIX`, `TZDIR`, `LOCPATH`, `aarch64-linux-gnu-gcc --sysroot`, and root-copied autotools support trees). |

## Fetching without bloating the workspace

Keep every download, extracted archive, `CARGO_HOME`, and `CARGO_TARGET_DIR` under `/tmp`. The repository workspace is snapshotted against a size and file cap, so extracting the payload or fetching the branch's git objects into `/home/user/mausVoice/.git` can exceed that cap.

### Inspect files or package lists with no download

Read branch metadata through the GitHub API before downloading gigabytes of payload:

```bash
gh api "repos/maus-inc/mausVoice/contents/FETCH.md?ref=vendor/sandbox-toolchain" \
  --jq '.content' | base64 -d
gh api "repos/maus-inc/mausVoice/contents/system/PKGS.txt?ref=vendor/sandbox-toolchain" \
  --jq '.content' | base64 -d | grep -i <package>
```

### Fetch a standalone static binary directly

Static binaries with no shared-library dependency in `system/tools/lib` (such as `gitleaks`, `ffmpeg`, and `ffprobe`) can be fetched individually without downloading the full tarball. Verify the downloaded file's SHA-256 against `MANIFEST.sha256` on the branch before executing it.

Example for live secret-scan verification (`pnpm run test:secret-scan` and commit-range `gitleaks detect`):

```bash
SV_SHA="$(gh api repos/maus-inc/mausVoice/git/ref/heads/vendor/sandbox-toolchain --jq '.object.sha')"
mkdir -p /tmp/gitleaks-fetch
gh api -H "Accept: application/vnd.github.raw" \
  "repos/maus-inc/mausVoice/contents/system/tools/bin/gitleaks?ref=${SV_SHA}" \
  > /tmp/gitleaks-fetch/gitleaks
EXPECTED="$(gh api "repos/maus-inc/mausVoice/contents/system/tools/GITLEAKS.txt?ref=${SV_SHA}" \
  --jq '.content' | base64 -d | awk '/^Binary sha256/ { print $NF }')"
echo "${EXPECTED}  /tmp/gitleaks-fetch/gitleaks" | sha256sum -c -
sudo install -m 0755 /tmp/gitleaks-fetch/gitleaks /usr/local/bin/gitleaks
gitleaks version
node scripts/ci/test-secret-history-scan.mjs --require-live
```

To run the same commit-range scan that `.github/workflows/secret-scan.yml` executes, write the trusted base commit's `gitleaks.toml` to a `.toml` file under `/tmp` (gitleaks dispatches config parsing on the filename extension):

```bash
POLICY_DIR="$(mktemp -d)"
git show "<base-sha>:gitleaks.toml" > "${POLICY_DIR}/gitleaks.toml"
gitleaks detect --log-opts="<base-sha>..<head-sha>" \
  -c "${POLICY_DIR}/gitleaks.toml" --redact --no-banner
rm -rf "${POLICY_DIR}"
```

### Fetch the full payload into `/tmp`

Use the `codeload.github.com` tarball when you need the Rust toolchain, Debian sysroot, Chromium, WebDriver drivers, models, or any dynamically linked binary in `system/tools/bin`:

```bash
set -euo pipefail
SV_SHA="$(gh api repos/maus-inc/mausVoice/git/ref/heads/vendor/sandbox-toolchain --jq '.object.sha')"
SV="$(mktemp -d /tmp/sandbox-vendor.XXXXXX)"
curl -sSL -o "${SV}.tar.gz" "https://codeload.github.com/maus-inc/mausVoice/tar.gz/${SV_SHA}"
tar xzf "${SV}.tar.gz" -C "${SV}" --strip-components=1
rm -f "${SV}.tar.gz"
cd "${SV}"
for f in $(grep -o '^[a-f0-9]\{64\}  .*\.part-00$' MANIFEST.sha256 | sed 's/.*  //; s/\.part-00$//'); do
  cat "${f}".part-* > "${f}"
  chmod --reference="${f}.part-00" "${f}"
done
sha256sum -c MANIFEST.sha256
```

Follow `FETCH.md` inside `${SV}` to wire the groups your task needs. Remove the tarball right after extraction so `/tmp` keeps enough free space for build outputs.

Do not run `git fetch origin vendor/sandbox-toolchain` inside the repository checkout. That writes multi-gigabyte packfiles into the checkout's `.git/objects/pack/` directory and risks exceeding the workspace snapshot limit. Note that the root `setup-toolchain.sh` helper runs `git fetch` into the repo checkout and unpacks only the Rust, sysroot, and native directories without reassembling split files under `system/tools/` or installing `/usr/local/bin/gitleaks`; prefer the `/tmp` tarball procedure above or the single-binary fast path.

## Trust and maintenance rules

- **Never merge `vendor/sandbox-toolchain`.** Keep it as a single orphan commit with zero parents, no pull requests, and no application imports.
- **Verify digests before use.** Run `sha256sum -c MANIFEST.sha256` on a full fetch or verify the file's expected SHA-256 on a single-file fetch.
- **Keep `/tmp` out of the repo.** Never commit `.cargo/config.toml` or extracted vendor files into the repository tree.
- **Rebuild when pins move.** Rebuild the branch using `engineering/sandbox-vendor-handoff-prompt.md` and `docs/sandbox-toolchain-vendor-spec.md` whenever any of the seven `Cargo.lock` files, `rust-toolchain.toml`, native `build.rs` archive pins, or Debian sysroot link dependencies change.
- **Check freshness before trusting a Cargo build.** Compare the seven repository `Cargo.lock` hashes against `rust/Cargo.lock.sha256` on the branch; a mismatch means the vendored crate tree needs a rebuild before offline `cargo --locked` builds can succeed.

# FETCH.md

How to wire up the vendored sandbox toolchain from the `vendor/sandbox-toolchain`
branch of `maus-inc/mausVoice`.

Everything extracts to `/tmp`. Do not extract anything into the workspace: the sandbox
snapshots the workspace, and turn-end artifacts are capped at roughly 128 MB and 10,000
files.

Eleven steps, in order. Steps 1 and 2 are the download and integrity check. Steps 3 to
6 are the toolchains. Step 7 is the two native build payloads that would otherwise
fail. Step 8 is Node and pnpm. Steps 9 and 10 run the gates and the sanity checks.
Step 11 is the list of things that will bite you.

Substitute the repository checkout path for `/path/to/mausVoice` throughout.

---

## Step 1. Download the branch

Option 1, one request and no git objects. Preferred.

```bash
BRANCH=vendor/sandbox-toolchain
mkdir -p /tmp/sandbox-vendor
curl -sSL -o /tmp/sandbox-vendor.tar.gz \
  "https://codeload.github.com/maus-inc/mausVoice/tar.gz/refs/heads/${BRANCH}"
tar xzf /tmp/sandbox-vendor.tar.gz -C /tmp/sandbox-vendor --strip-components=1
rm /tmp/sandbox-vendor.tar.gz
```

Option 2, a clone with no history.

```bash
git clone --depth 1 --single-branch --branch vendor/sandbox-toolchain \
  https://github.com/maus-inc/mausVoice.git /tmp/sandbox-vendor
```

Do **not** use `--filter=blob:none` and then read files. A partial clone fetches blobs
one at a time on demand, and against a branch with thousands of blobs that is
catastrophically slow. If you only need the tree listing, use the API instead:

```bash
gh api "repos/maus-inc/mausVoice/git/trees/vendor%2Fsandbox-toolchain?recursive=1"
```

For one or two small files, skip the whole download:

```bash
gh api repos/maus-inc/mausVoice/contents/rust/Cargo.lock.sha256 \
  -H 'Accept: application/vnd.github+json' -f ref=vendor/sandbox-toolchain \
  --jq .content | base64 -d
```

Note the `-f ref=`: `gh api` needs the ref passed as a field, not as a query string.

## Step 2. Reassemble the split archives and verify

Large archives are split at 90 MiB and named `<archive>.part-00`, `.part-01`, and so
on. `MANIFEST.sha256` lists each one under its reassembled name, which is how this
one-liner knows what to join.

```bash
cd /tmp/sandbox-vendor
for f in $(grep -o '^[a-f0-9]\{64\}  .*\.part-00$' MANIFEST.sha256 | sed 's/.*  //; s/\.part-00$//'); do
  cat "$f".part-* > "$f"
done
sha256sum -c MANIFEST.sha256
```

Require every line to report OK and zero failures before continuing. Do not delete the
`.part-*` files until the check passes.

## Step 3. Wire up the Rust toolchain

The branch ships the five components for Rust 1.88.0, which is what
`rust-toolchain.toml` pins.

```bash
RUST_PREFIX=/tmp/rust-tools
mkdir -p "$RUST_PREFIX"
for t in /tmp/sandbox-vendor/rust/toolchain/*-1.88.0-*.tar.xz; do
  d=$(mktemp -d)
  tar xJf "$t" -C "$d"
  "$d"/*/install.sh --prefix="$RUST_PREFIX" --disable-ldconfig
  rm -rf "$d"
done
export PATH="$RUST_PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$RUST_PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

rustc --version    # rustc 1.88.0 (6b00bc388 2025-06-23)
cargo --version    # cargo 1.88.0 (873a06493 2025-05-10)
cargo clippy --version
cargo fmt --version
```

`--disable-ldconfig` matters: the sandbox has no root and no writable
`/etc/ld.so.conf.d`. `LD_LIBRARY_PATH="$RUST_PREFIX/lib"` is required at run time.

Do not set `RUSTUP_HOME` or `CARGO_HOME` at the workspace. The repository's
`.gitignore` reserves `.tooling/` for a local toolchain, but the rule here is still
`/tmp`.

## Step 4. Wire up the cargo vendor tree, offline

```bash
mkdir -p /tmp/cargo-vendor
tar xJf /tmp/sandbox-vendor/rust/cargo-vendor.tar.xz -C /tmp/cargo-vendor

export CARGO_HOME=/tmp/cargo-home
mkdir -p "$CARGO_HOME"
sed 's|^directory = .*|directory = "/tmp/cargo-vendor"|' \
  /tmp/sandbox-vendor/rust/cargo-config.toml > "$CARGO_HOME/config.toml"
export CARGO_NET_OFFLINE=true

cd /path/to/mausVoice
sha256sum -c /tmp/sandbox-vendor/rust/Cargo.lock.sha256
```

The config must keep the `ferrous-focus` git stanza. If you flatten it to crates-io
only, offline resolution of that git dependency fails.

The shipped `cargo-config.toml` already points `directory` at `/tmp/cargo-vendor`, so
the `sed` above is a no-op unless you extracted somewhere else. It is there to make the
requirement explicit.

Two things worth knowing about the repository's own sandbox documentation. First,
`docs/Installing-cargo-toolchain-for-kilocode-bot-agents-in-a-linux-sandbox.md` step 4
suggests `[net] git-fetch-with-cli = true` in `apps/desktop/src-tauri/.cargo/config.toml`
because `libgit2` fetches fail in restricted sandboxes. With a complete vendor tree that
is unnecessary. Second, and more important: **do not commit `.cargo/config.toml` into
the repository.** CI expects crates.io. If you need it, put it in
`$CARGO_HOME/config.toml` under `/tmp`, never in the checkout.

## Step 5. Wire up the Debian 12 development sysroot

```bash
mkdir -p /tmp/gtk-sysroot
tar xJf /tmp/sandbox-vendor/system/debian12-dev-sysroot.tar.xz -C /tmp/gtk-sysroot

export PKG_CONFIG_SYSROOT_DIR=/tmp/gtk-sysroot
export PKG_CONFIG_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/tmp/gtk-sysroot/usr/share/pkgconfig
export PKG_CONFIG=/tmp/sandbox-vendor/system/tools/bin/pkg-config
export CPATH=/tmp/gtk-sysroot/usr/include:/tmp/gtk-sysroot/usr/include/x86_64-linux-gnu
export LIBRARY_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu
export LD_LIBRARY_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

export LIBCLANG_PATH=/tmp/gtk-sysroot/usr/lib/llvm-14/lib
```

`LIBCLANG_PATH` is required here. `bindgen` 0.71.1 and 0.72.1 are both in the
dependency graph through `clang-sys`, and `whisper-rs-sys` and `ort-sys` use bindgen.
The path is the one this branch was verified with.

If `pkg-config` cannot find a module, the usual cause is a `.pc` file in a multiarch
directory you did not add to `PKG_CONFIG_PATH`. Both multiarch directories are above.
If the sysroot carries a `lib/pkgconfig` directory too, add it.

## Step 6. Command line tools

```bash
export PATH=/tmp/sandbox-vendor/system/tools/bin:$PATH
pkg-config --version   # 1.8.1
cmake --version        # 3.25.1
patchelf --version     # 0.14.3
file --version         # 5.44
```

No `LD_LIBRARY_PATH` is needed: the tree is rpath'd to `$ORIGIN/../lib`. Copy the whole
`system/tools/` tree, never individual files, because `bin/pkg-config` is a symlink to
`bin/pkgconf` in the same directory.

`cmake` must be on `PATH` before any cargo build of `rust_transcription`, because the
`cmake` crate resolves the binary from the environment.

## Step 7. Native build payloads

This step has no counterpart in the older reference branch. Both build scripts
download from GitHub Releases, which a restricted sandbox cannot reach.

```bash
mkdir -p /tmp/ort
tar xzf /tmp/sandbox-vendor/native/onnxruntime/onnxruntime-linux-x64-1.23.2.tgz -C /tmp/ort
export MAUSVOICE_ORT_DYLIB_PATH="$(find /tmp/ort -name libonnxruntime.so | head -1)"
[ -f "$MAUSVOICE_ORT_DYLIB_PATH" ] || { echo "ORT .so not found"; exit 1; }

export SHERPA_ONNX_ARCHIVE_DIR=/tmp/sandbox-vendor/native/sherpa-onnx

export CMAKE_TOOLCHAIN_FILE=/path/to/mausVoice/packages/rust_transcription/cmake/linux-ci-toolchain.cmake
```

`MAUSVOICE_ORT_DYLIB_PATH` points at a file, not a directory. `build.rs` copies it
beside the built binaries and into `deps/`.

`SHERPA_ONNX_ARCHIVE_DIR` points at the directory holding the archive. `build.rs` copies
the archive into its cache and verifies the pinned digest, so the digest check stays
live. If you instead point `SHERPA_ONNX_LIB_DIR` at an extracted `lib` directory, the
digest check is bypassed entirely.

`CMAKE_TOOLCHAIN_FILE` is set by every CI job that builds the sidecar, and its only
content is `set(GGML_NATIVE OFF CACHE BOOL "" FORCE)`. Omitting it produces a binary
tuned to the build host, which is harmless in a sandbox but divergent from CI.

Full details, including the complete pinned digest tables, are in
`native/onnxruntime/ONNXRUNTIME.txt` and `native/sherpa-onnx/SHERPA.txt`.

## Step 8. Node and pnpm

```bash
node --version          # v22.22.3 in the sandbox; satisfies root engines ^22.22.2
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm --version          # 10.34.5, matching the root packageManager field
```

Then, from the repository root:

```bash
export CHROMEDRIVER_SKIP_DOWNLOAD=true
pnpm install --frozen-lockfile
```

`CHROMEDRIVER_SKIP_DOWNLOAD=true` is mandatory. `chromedriver` is in
`pnpm.onlyBuiltDependencies`, so its install script runs under a normal install, tries
to download from an unreachable CDN, and exits 1, which fails the whole install. The
variable makes it exit 0 immediately. Nothing in CI runs the WebdriverIO suite, so the
missing binary costs nothing.

`pnpm install --frozen-lockfile --ignore-scripts` also works and is what
`test-desktop-unit.yml` uses. It skips the `esbuild` and `sharp` postinstalls too, which
is fine for `vitest` and `tsc` but not fine if you then run `turbo run build`.

## Step 9. Build, lint and test

```bash
cd /path/to/mausVoice
export TAURI_CONFIG='{"bundle":{"externalBin":[]}}'

for crate in apps/desktop/src-tauri packages/rust_pill_shared packages/rust_gtk_pill \
             packages/rust_macos_pill packages/rust_windows_pill packages/rust_transcription; do
  (cd "$crate" && cargo fmt --check) || exit 1
done

(cd apps/desktop/src-tauri && cargo clippy --locked -- -D warnings) || exit 1
(cd packages/rust_pill_shared && cargo clippy --locked --all-targets -- -D warnings) || exit 1

(cd apps/desktop/src-tauri && CARGO_BUILD_JOBS=1 cargo test --locked --lib) || exit 1
CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --lib
cargo test --locked --manifest-path packages/rust_pill_shared/Cargo.toml
xvfb-run -a cargo test --locked --manifest-path packages/rust_gtk_pill/Cargo.toml

pnpm --filter desktop run lint
pnpm --filter desktop run check-types
pnpm --filter desktop run test:unit
pnpm --filter @maus-inc/voice-ai run test
pnpm --filter @repo/agent test
```

`TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` is set by every CI job that runs cargo
against `apps/desktop/src-tauri`. Without it, `tauri-build` expects
`binaries/rust-transcription-cpu` and `binaries/rust-transcription-gpu` to exist, and
they do not in a fresh checkout.

`CARGO_BUILD_JOBS=1` is required for the desktop `cargo test`. On a 3.9 GB two-core
sandbox, parallel linking gets the linker OOM-killed with `signal 9`.

### Gate results on this branch

Filled in from the build. Every row ran in a clean `debian:12` container using only the
payloads on this branch.

| Gate | Command | Result |
| --- | --- | --- |
| G-1 toolchain | `rustc/cargo/clippy/fmt --version` | 1.88.0 / 1.88.0 / 0.1.88 / 1.8.0-stable |
| G-2 offline resolve | `cargo metadata --locked` for all seven manifests | 7 of 7 exit 0 |
| G-3 fmt | `cargo fmt --check` in six crates | 6 of 6 pass |
| G-4 clippy desktop | `cargo clippy --locked -- -D warnings` | pass, 6m 13s, 0 warnings |
| G-4b clippy all-targets | desktop and `rust_pill_shared` | both pass |
| G-4c clippy gtk pill | `--manifest-path packages/rust_gtk_pill/Cargo.toml --all-targets` | pass |
| G-5 test desktop lib | `CARGO_BUILD_JOBS=1 cargo test --locked --lib` | 363 passed, 0 failed, 1 ignored |
| G-5b test transcription | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --lib` | 64 passed, 0 failed, 1 ignored |
| G-5c test pill_shared | `cargo test --locked --manifest-path packages/rust_pill_shared/Cargo.toml` | 242 passed, 0 failed |
| G-5d test gtk pill | `xvfb-run -a cargo test --locked --manifest-path packages/rust_gtk_pill/Cargo.toml` | 42 passed, 0 failed |
| G-5e sidecar integration | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --test sidecar_integration` | 7 passed, 0 failed, 4 ignored |
| G-6 sherpa build-script | `node --test scripts/ci/sherpa-build-script-tests.test.mjs` | 47 passed, 0 failed |
| G-6b sherpa link mode | `node --test scripts/ci/sherpa-onnx-link-mode.test.mjs` | 4 passed, 0 failed |
| G-6c sherpa digests | `node --test scripts/ci/verify-sherpa-archives.test.mjs` | 5 passed, 0 failed |
| G-7 ci guards | `node --test scripts/ci/*.test.mjs` | 371 passed, 0 failed |
| G-8 pnpm install | `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` | done in 13.2s |
| G-9 turbo build | `pnpm run build` | 11 of 11 tasks successful |
| G-10a desktop lint | `pnpm --filter desktop run lint` | prettier, oxlint (0 warnings, 0 errors) and ui-lint all pass |
| G-10b check-types | `pnpm --filter desktop run check-types` | pass |
| G-10c desktop unit | `pnpm --filter desktop run test:unit` | 3043 passed across 229 files |
| G-10d voice-ai | `pnpm --filter @maus-inc/voice-ai run test` | 501 passed across 37 files |
| G-10e agent | `pnpm --filter @repo/agent test` | 24 passed |
| G-10f preview | `pnpm --filter @maus-inc/preview test` | 22 passed across 4 files |
| G-11 bindings | `bash scripts/check-bindings.sh` | regenerated, consistent, no diff |
| G-12 i18n | `pnpm --filter desktop i18n` then `git diff --exit-code` on locales | in sync, no diff |
| G-13 icons | `node scripts/generate-app-icons.mjs --check` | alpha, ICO frames and ICNS all OK |
| G-14 integration vitest | `pnpm --filter desktop run test:integration` | fails only on the missing `GROQ_API_KEY`, as `AGENTS.md` predicts |

Three notes on the run.

The `--ignored` sidecar tests passed during this build, and that is an artifact of the
builder, not a property of the payload. The builder has unrestricted internet, so those
four tests downloaded real Parakeet and Canary models and ran real ONNX inference. In a
restricted sandbox they cannot reach `huggingface.co` and will be skipped, which is the
expected outcome there.

`G-7` first reported 3 failures in `check-workspace-hygiene.test.mjs`. The cause was
`git` refusing to read the checkout because of a `safe.directory` ownership mismatch in
the builder, not a defect in the payload. After `git config --global --add safe.directory`
the same suite passed 27 of 27 and the full `node --test scripts/ci/*.test.mjs` run
passed 371 of 371. A consumer whose checkout is owned by a different user than the one
running the tests will hit the same thing; it is a git configuration issue, and the fix
is the one shown above.

`G-10a`'s prettier step, `G-10b`'s `tsc`, and `G-11`'s bindings check all read the
working tree, so they were run against the same checkout the Rust gates used.

## Step 10. Sanity checks

```bash
export PKG_CONFIG=/tmp/sandbox-vendor/system/tools/bin/pkg-config
for m in gtk+-3.0 gdk-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 openssl \
         glib-2.0 gio-2.0 gobject-2.0 cairo pango pangocairo gdk-pixbuf-2.0 atk \
         atk-bridge-2.0 librsvg-2.0 ayatana-appindicator3-0.1 gtk-layer-shell-0 \
         alsa libpulse libpulse-simple gstreamer-1.0 gstreamer-plugins-base-1.0 \
         enchant-2 libudev x11 xext xrandr xi xcursor xcb xkbcommon wayland-client \
         harfbuzz liblzma zlib libzstd; do
  printf '%-30s %s\n' "$m" "$("$PKG_CONFIG" --modversion "$m" 2>&1)"
done
# Every line must print a version.

find /tmp/gtk-sysroot -xtype l | grep -E '\.so' || echo "no broken library symlinks"
find /tmp/gtk-sysroot -type l -lname '/*'    # must be empty

printf 'int main(){return 0;}\n' > /tmp/t.c
gcc /tmp/t.c -o /tmp/t.out -L/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu \
  -ldbus-1 -lffi -luuid -lpcre2-8 -lzstd -lmount -lblkid -ludev \
  -lasound -lpulse -lpulse-simple -lxdo -lgtk-3 -lgdk-3 -lwebkit2gtk-4.1 \
  -ljavascriptcoregtk-4.1 -lsoup-3.0 -lgtk-layer-shell && echo "link ok"

find /tmp/gtk-sysroot -type f -print0 | xargs -0 file | grep -v "ELF 64-bit" | grep ELF
# must be empty: every ELF is 64-bit x86-64
```

## Step 11. Cautions

* Do not extract into the workspace. Use `/tmp`.
* Do not commit `.cargo/config.toml` into the repository. CI expects crates.io.
* Do not point `CARGO_HOME` at the workspace.
* `system/tools/bin/pkg-config` is a symlink to `pkgconf` in the same directory. Copy
  the whole tree.
* Do not unset `MAUSVOICE_ORT_DYLIB_PATH` or `SHERPA_ONNX_ARCHIVE_DIR` mid-session. A
  later `cargo build` of `rust_transcription` will try GitHub Releases and fail after
  minutes of compiling.
* Do not delete `patches/`. Two crates are path-patched from there and `rdev` is a path
  dependency, and the vendor tree deliberately does not contain them.
* One shared `CARGO_TARGET_DIR` across the seven crates saves gigabytes and a lot of
  time. Note that the `sherpa-onnx-prebuilt/` and `mausvoice-onnxruntime/` caches are
  keyed off it, so if you change it, re-seed them.
* The `--ignored` tests in `packages/rust_transcription/tests/sidecar_integration.rs`
  cannot pass: they download model weights from `huggingface.co`, which is unreachable.
  This is expected. The non-ignored tests in that file do run.

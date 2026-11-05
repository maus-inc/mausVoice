# FETCH.md

How to wire up the vendored sandbox toolchain from the `vendor/sandbox-toolchain`
branch of `maus-inc/mausVoice`.

Everything extracts to `/tmp`. Do not extract anything into the workspace: the sandbox
snapshots the workspace, and turn-end artifacts are capped at roughly 128 MB and 10,000
files.

Eleven steps, in order. Steps 1 and 2 are the download and integrity check. Steps 3 to
6 are the toolchains. Step 7 is the two native build payloads that would otherwise
fail, with sub-steps 7b to 7k for the optional groups. Step 8 is Node and pnpm. Steps 9
and 10 run the gates and the sanity checks. Step 11 is the list of things that will
bite you.

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

## Step 3b. Cross-target standard libraries (G12)

Optional. Needed only to type-check code behind `#[cfg(windows)]` and
`#[cfg(target_os = "macos")]`, which the host `cargo clippy` never compiles.

```bash
RUST_PREFIX=/tmp/rust-tools
for t in x86_64-pc-windows-msvc aarch64-apple-darwin; do
  d=$(mktemp -d)
  tar xJf "/tmp/sandbox-vendor/rust/targets/$t/rust-std-1.88.0.tar.xz" -C "$d"
  cp -r "$d"/rust-std-"$t"/lib/rustlib/"$t" "$RUST_PREFIX"/lib/rustlib/
  rm -rf "$d"
done

rustc --print sysroot
ls "$RUST_PREFIX"/lib/rustlib/x86_64-pc-windows-msvc/lib/libstd-*.rlib
ls "$RUST_PREFIX"/lib/rustlib/aarch64-apple-darwin/lib/libstd-*.rlib
```

The two digests are the `xz_hash` values `channel-rust-1.88.0.toml` publishes, so
they carry no new trust assumption. The channel date is 2025-06-26.

`cargo check --locked --target <target>` does not link, so no Windows SDK and no
macOS SDK is needed. `rustc --print target-list` proves nothing on its own; it
lists targets without their standard libraries. Confirm the `libstd-*.rlib` files
exist for both targets before recording the check as run.

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

## Step 7b. Model weights (G10)

Optional. Needed only to run the four `#[ignore]` tests in
`packages/rust_transcription/tests/sidecar_integration.rs` against real models
instead of synthetic buffers. The model files are already reassembled by Step 2,
because `ggml-base.bin` and `model.int8.onnx` are split there.

```bash
MODELS=/tmp/mausvoice-models
mkdir -p "$MODELS"
cp -r /tmp/sandbox-vendor/models/whisper "$MODELS"/
mkdir -p "$MODELS"/onnx
cp -r /tmp/sandbox-vendor/models/onnx/sense-voice "$MODELS"/onnx/
export RUST_TRANSCRIPTION_MODELS_DIR="$MODELS"
```

The sidecar looks for `<dir>/<model-file>` for whisper and
`<dir>/<model-id>/<artifact>` for ONNX. Nothing verifies transcript content, only
that a model loaded and produced text. The Parakeet CTC, Parakeet TDT and Canary
1B bundles are not vendored; their digests are pinned in
`packages/rust_transcription/src/models.rs` if a task needs them.

## Step 7c. WebDriver driver chain (G11)

Optional. Needed only for `pnpm --filter desktop test:webdriver` on Linux.

```bash
export PATH=/tmp/sandbox-vendor/drivers/tauri-driver:$PATH
export PATH=/tmp/sandbox-vendor/drivers/chromedriver-152.0.0:$PATH
tauri-driver --version        # 2.0.6; 2.1.0 needs rustc 1.90
chromedriver --version        # 152.0.7977.42

# WebKitWebDriver lives inside the extracted sysroot, not in this group:
ls /tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebDriver
```

`tauri-driver` 2.1.0 is the current release and requires rustc 1.90 or newer,
above the 1.88.0 this repository pins, so the payload carries 2.0.6. This group
carries no browser.

## Step 7d. UI capture media tools (G9)

Optional. Needed only for `.agents/skills/ui-capture/SKILL.md`, which records a
UI change into a GIF. `ffmpeg`, `ffprobe` and `gifsicle` are already on `PATH`
from Step 6, because they sit in `system/tools/bin` beside `cmake` and `file`.

```bash
ffmpeg -version     # 7.0.2-static
ffprobe -version    # 7.0.2-static
gifsicle --version  # LCDF Gifsicle 1.95
gitleaks version    # 8.18.0 (G13; note `version`, not `--version`)
```

`tesseract` is no longer absent: G19 ships it (Step 7h), so `ui-capture`'s
`validate.mjs` runs the OCR caption round-trip. Set `TESSDATA_PREFIX` as Step 7h
shows, or the round-trip fails on a missing `eng.traineddata`.

## Step 7e. Debuggers and syscall tracers (G16)

Optional. `gdb`, `strace`, `ltrace` and `valgrind` sit in `system/tools/bin`.

```bash
gdb --data-directory=/tmp/sandbox-vendor/system/tools/share/gdb --version  # 13.1
strace --version       # 6.1
ltrace --version       # 0.7.3
VALGRIND_LIB=/tmp/sandbox-vendor/system/tools/libexec/valgrind valgrind --version  # 3.19.0
```

`gdb` needs `--data-directory` or its embedded Python cannot import the `gdb`
module, because the path is compiled in as `/usr/share/gdb/python`.
`valgrind` needs `VALGRIND_LIB`, because `memcheck` and the other tools are
separate programs under `libexec`. Set both in the environment you build with.

`valgrind` also needs the debug symbols for the traced program's glibc, or it
aborts at startup with `A must-be-redirected function ... was not found`. The
payload carries the Debian 12 build-id tree under `system/tools/debug/libc6-dbg`
for this. Copy it into place, which needs root:

```bash
sudo mkdir -p /usr/lib/debug
sudo cp -a /tmp/sandbox-vendor/system/tools/debug/libc6-dbg/.build-id /usr/lib/debug/
env -i PATH=$T/bin:/usr/bin:/bin HOME=/tmp \
  VALGRIND_LIB=$T/libexec/valgrind $T/bin/valgrind --tool=memcheck /bin/true
# must print "0 errors from 0 contexts", not the redirection abort
```

The symbols must match the glibc the traced binary loads. The Arena agent sandbox
is Debian 12, so this 2.36 tree is right there. On a host whose glibc differs,
install that host's `libc6-dbg` and leave this tree unused. `system/tools/debug/VALGRIND-DEBUG.txt`
records the same.

## Step 7f. Native build tools (G17)

Optional. `ninja`, `meson`, `autoconf`, `automake`, `libtool`, `m4`, `bison` and
`flex` sit in `system/tools/bin`. The autotools are Perl scripts and need a `perl`
on `PATH`, which the base image supplies.

```bash
ninja --version        # 1.11.1
meson --version        # 1.0.1 (needs a python3 on PATH; module tree is in the payload)
autoconf --version     # 2.71
automake --version     # 1.16.5
libtoolize --version   # 2.4.7
m4 --version           # 1.4.19
bison --version        # 3.8.2
flex --version         # 2.6.4
```

`meson` is a Python program. Its module tree travels in the payload under
`lib/python3/dist-packages/mesonbuild`, and the `meson` entry point is a small
wrapper that puts that tree on `PYTHONPATH` and calls a `python3` it finds on
`PATH`. The base image supplies the interpreter; the payload does not ship one.

The autotools are the one group that is not relocatable. `autoconf`, `autom4te`,
`autoheader`, `automake`, `aclocal` and `libtoolize` each read their macro and
library trees from a path compiled in at build time, `/usr/share/autoconf`,
`/usr/share/aclocal`, `/usr/share/aclocal-1.16`, `/usr/share/automake-1.16` and
`/usr/share/libtool`, and `autoconf` execs `/usr/bin/autom4te`. No env var
redirects all of them at once, so a relocatable run needs the support trees and
the scripts copied to those paths, which needs root:

```bash
T=/tmp/sandbox-vendor/system/tools
sudo cp -a $T/share/autoconf/.        /usr/share/autoconf/
sudo cp -a $T/share/aclocal/.         /usr/share/aclocal/
sudo cp -a $T/share/aclocal-1.16/.    /usr/share/aclocal-1.16/
sudo cp -a $T/share/automake-1.16/.   /usr/share/automake-1.16/
sudo cp -a $T/share/libtool/.         /usr/share/libtool/
sudo cp -a $T/bin/m4 $T/bin/autom4te $T/bin/autoconf $T/bin/autoheader \
            $T/bin/autoreconf $T/bin/aclocal-1.16 $T/bin/automake-1.16 \
            $T/bin/libtoolize /usr/bin/
sudo ln -sf automake-1.16 /usr/bin/automake
sudo ln -sf aclocal-1.16  /usr/bin/aclocal
```

Then the round trip works under `env -i` with the tools directory on `PATH`:

```bash
cd /tmp && rm -rf att && mkdir att && cd att
printf 'AC_INIT([t],[1.0])\nAM_INIT_AUTOMAKE\nAC_PROG_CC\nAC_CONFIG_FILES([Makefile])\nAC_OUTPUT\n' > configure.ac
printf 'bin_PROGRAMS = t\nt_SOURCES = t.c\n' > Makefile.am
printf 'int main(){return 0;}\n' > t.c
touch AUTHORS ChangeLog NEWS README
env -i PATH=$T/bin:/usr/bin:/bin HOME=/tmp autoreconf -i   # writes configure and Makefile.in
env -i PATH=$T/bin:/usr/bin:/bin HOME=/tmp ./configure     # exit 0
env -i PATH=$T/bin:/usr/bin:/bin HOME=/tmp make            # links ./t
```

Proven on 2026-11-05 in the second agent sandbox: `autoreconf -i` wrote
`configure` and `Makefile.in`, `./configure` exited 0 and `make` linked `./t`.
Without the support trees, `aclocal` aborts with
`Can't locate Automake/Config.pm in @INC`, then `autom4te` with
`Can't locate Autom4te/C4che.pm in @INC`, then `autoconf` with
`exec: /usr/bin/autom4te: not found`.

## Step 7g. Database clients (G18)

Optional. `sqlite3`, `psql`, `mariadb` and `redis-cli` sit in `system/tools/bin`.

```bash
sqlite3 --version      # 3.40.1
psql --version         # 15.8
mariadb --version      # 10.11.6
redis-cli --version    # 7.0.15
```

`psql` here is the real client, not the Debian Perl wrapper, and it carries its
own `libpq.so.5` beside it.

## Step 7h. OCR (G19)

Optional. `tesseract` 5.3.0 sits in `system/tools/bin` with `eng.traineddata`
under `share/tessdata`.

```bash
export TESSDATA_PREFIX=/tmp/sandbox-vendor/system/tools/share/tessdata
tesseract --version    # 5.3.0
tesseract --list-langs # must include eng
```

This closes the OCR round trip `ui-capture`'s `validate.mjs` runs, which needs
`eng.traineddata` on `TESSDATA_PREFIX`.

## Step 7i. Shell, crypto, archive and network tools (G20)

Optional. `shellcheck`, `shfmt`, `gpg`, `gpgv`, `git-lfs`, `zstd`, `brotli`,
`7z`, `dig` and `tcpdump` sit in `system/tools/bin`.

```bash
shellcheck --version   # 0.9.0
shfmt --version        # 3.6.0
gpg --version          # 2.2.40
git-lfs --version      # 3.3.0
zstd --version         # 1.5.4
brotli --version       # 1.0.9
7z                     # 22.01; the version banner prints with no arguments
dig -v                 # 9.18.28; `dig` has no --version
tcpdump --version      # 4.99.3
```

## Step 7j. Cross compilers and emulation (G21)

Optional, and the largest group. `x86_64-w64-mingw32-gcc`,
`aarch64-linux-gnu-gcc` and `qemu-aarch64-static` sit in `system/tools/bin`,
and the trees they resolve by a fixed relative layout are preserved beside them.

```bash
export T=/tmp/sandbox-vendor/system/tools
x86_64-w64-mingw32-gcc --version    # 12-win32
aarch64-linux-gnu-gcc --version     # 12.2.0
qemu-aarch64-static --version       # 7.2.13
```

The cross compilers are not standalone binaries. Each needs its `cc1` from
`lib/gcc/<triple>/<version>`, its target headers and libraries from a fixed
relative sysroot, and its binutils from `<triple>/bin`, which are symlinks into
`bin/`. All of those travel in the payload.

`aarch64-linux-gnu-gcc` needs `--sysroot=$T` to find its target libc, and the
result runs under `qemu-aarch64-static -L $T/usr/aarch64-linux-gnu`.

## Step 7k. SBOM and vulnerability scanning (G22)

Optional. `trivy`, `syft`, `grype` and `osv-scanner` sit in `system/tools/bin`.
`trivy` is split as `trivy.part-00` and `trivy.part-01` and is reassembled by
Step 2.

```bash
trivy --version        # 0.76.2
syft --version         # 1.20.0
grype --version        # 0.87.0
osv-scanner --version  # 1.9.2
```

Their release assets and published sha256 values are in
`system/tools/G22.txt`, and each digest was checked against the project's own
checksum manifest at build time.

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

### Sanity checks for the third delivery (G16 to G22)

Run these from a private copy of the tools tree, so the check proves the shipped
layout rather than the build host's `PATH`.

```bash
T=/tmp/sandbox-vendor/system/tools

# Every G16 to G22 binary prints a version under env -i, with no LD_LIBRARY_PATH.
# Four need the env var or flag named in their step above.
env -i PATH=$T/bin:/usr/bin:/bin HOME=/tmp \
  $T/bin/gdb --data-directory=$T/share/gdb --version | head -1
env -i PATH=$T/bin:/usr/bin:/bin HOME=/tmp VALGRIND_LIB=$T/libexec/valgrind \
  $T/bin/valgrind --version
env -i PATH=$T/bin:/usr/local/bin:/usr/bin:/bin HOME=/tmp $T/bin/meson --version
env -i PATH=$T/bin:/usr/bin:/bin HOME=/tmp \
  TESSDATA_PREFIX=$T/share/tessdata $T/bin/tesseract --list-langs   # must list eng

# A cross compile and an emulated run.
printf '#include <stdio.h>\nint main(){puts("hi");return 0;}\n' > /tmp/hi.c
$T/bin/x86_64-w64-mingw32-gcc /tmp/hi.c -o /tmp/hi.exe
head -c2 /tmp/hi.exe | od -c | head -1                 # M Z
$T/bin/aarch64-linux-gnu-gcc --sysroot=$T /tmp/hi.c -o /tmp/hi.aarch64
$T/bin/qemu-aarch64-static -L $T/usr/aarch64-linux-gnu /tmp/hi.aarch64   # hi

# No broken symlink points outside the tree.
T=$T python3 - <<'PY'
import os
root = os.environ["T"]
bad = [os.path.relpath(os.path.join(dp, f), root)
       for dp, dn, fn in os.walk(root) for f in fn + dn
       if os.path.islink(os.path.join(dp, f)) and not os.path.exists(os.path.join(dp, f))]
print(len(bad), "broken symlinks")
PY
```

Expected: 30 version checks pass, the mingw output starts `M Z`, the emulated
binary prints `hi`, and the broken-symlink count is 0.

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
  download model weights from `huggingface.co`, which is unreachable. Follow Step 7b and
  point `RUST_TRANSCRIPTION_MODELS_DIR` at the shipped weights, and the whisper and
  SenseVoice tests run. The Parakeet and Canary tests still cannot, because those
  bundles are not shipped. The non-ignored tests in that file run without any of this.

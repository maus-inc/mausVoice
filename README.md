# Vendored sandbox toolchain

This is an **orphan branch** of `maus-inc/mausVoice`. It carries no application source.
It carries the binaries, archives and source trees that a network-restricted agent
sandbox cannot fetch for itself, so that the sandbox can run this repository's real
verification gates through the git protocol alone:

```
cargo fmt --check   cargo clippy -- -D warnings   cargo test
pnpm install        vitest                        tsc
```

A sandbox fetches this branch, extracts it to `/tmp`, uses it, and deletes it.

**Never merge this branch into `main`. Never open a pull request from it. Never let it
enter a release or CI workflow.** Nothing here is imported by the application at build
or run time.

Built against `maus-inc/mausVoice` at commit
`249e465b9eca27b70c4c74da79ff9fb88517d1d5` (branch `arena/0.1.6-consolidation`,
app version `0.1.6`). Every size and version below was measured during the build.

## Who this is for

An agent working inside a sandbox whose outbound network is limited to
`github.com`, `codeload.github.com`, `api.github.com`, `registry.npmjs.org`,
`pypi.org` and `files.pythonhosted.org`.

The trap that drives most of this payload: `github.com` is reachable, but a GitHub
**Release asset download** is a 302 redirect to `objects.githubusercontent.com`, which
is not. Both of this repository's build-time native downloads are GitHub Release
assets, so they fail, and they fail late, after cargo has compiled several hundred
crates. This branch supplies those payloads and the environment variables that point
the build scripts at them.

## What is here

| Directory | What it holds | Packed | Extracted |
| --- | --- | --- | --- |
| `rust/toolchain/` | Rust 1.88.0: `rustc`, `rust-std`, `cargo`, `rustfmt`, `clippy`, plus `channel-rust-1.88.0.toml` | 127 MB | 602 MB |
| `rust/` (top level) | `cargo-vendor.tar.xz` parts (union of seven Cargo workspaces), `cargo-config.toml`, `Cargo.lock.sha256` | 132 MB | 1.73 GB |
| `system/` (top level) | `PKGS.txt` (634 packages) and `debian12-dev-sysroot.tar.xz` parts | 417 MB | 1.94 GB |
| `system/tools/` | `cmake`, `file`, `patchelf`, `pkgconf`, a complete 44-library closure, `TOOLS.txt` (88 rows), and `share/cmake-3.25` | 82 MB | 82 MB |
| `system/build/` | the three scripts that derived the sysroot links and the tools closure, with their own `README.md` | 15 KB | 15 KB |
| `native/onnxruntime/` | `onnxruntime-linux-x64-1.23.2.tgz` and `ONNXRUNTIME.txt` | 8.3 MB | 23 MB |
| `native/sherpa-onnx/` | `sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2` and `SHERPA.txt` | 22 MB | 138 MB |
| `LICENSES/` | `debian/<package>/copyright` for 605 packages, plus ONNX Runtime, sherpa-onnx and whisper.cpp texts | 9.7 MB | 9.7 MB |
| root | `README.md`, `FETCH.md`, `MANIFEST.sha256` | 0.54 MB | 0.54 MB |
| **total** | | **799 MB** | **4.5 GB** |

Packed is the exact sum of the files as they sit on the branch. Extracted is after
unpacking to `/tmp`. Both are MB (10^6 bytes). The codeload tarball a consumer actually
downloads is 737 MB, smaller than the packed sum because git compresses the tree.

Extracted total is roughly 4.5 GB. That fits in the ~19 GB a sandbox has, but only if
nothing is extracted into the workspace and the downloaded tarball is deleted after
extraction.

## How to consume it

See `FETCH.md`. It is eleven numbered steps, in order, and every step extracts to
`/tmp`. The short version:

1. Download the branch with `codeload` or a depth-1 clone.
2. Reassemble the split archives and `sha256sum -c MANIFEST.sha256`.
3. Install the Rust 1.88.0 toolchain to `/tmp/rust-tools`.
4. Extract the cargo vendor tree to `/tmp/cargo-vendor` and write
   `$CARGO_HOME/config.toml` from the shipped stanza.
5. Extract the sysroot to `/tmp/gtk-sysroot` and export the `PKG_CONFIG_*`,
   `CPATH`, `LIBRARY_PATH` and `LIBCLANG_PATH` variables.
6. Put `system/tools/bin` on `PATH`.
7. Point the two native build scripts at the vendored payloads with
   `MAUSVOICE_ORT_DYLIB_PATH` and `SHERPA_ONNX_ARCHIVE_DIR`.
8. Enable pnpm through `corepack` and install with
   `CHROMEDRIVER_SKIP_DOWNLOAD=true`.
9. Run the gates.
10. Run the sanity checks.
11. Read the cautions.

## Verification performed before this branch was pushed

Every row is a command that was run in a clean `debian:12` container using only the
payloads on this branch and a checkout of `mausVoice` at the reference commit.

| Check | Command | Result |
| --- | --- | --- |
| Rust component hashes | `sha256sum` each `*-1.88.0-*.tar.xz` vs `xz_hash` in `channel-rust-1.88.0.toml` | 5 of 5 MATCH |
| Toolchain versions | `rustc --version`, `cargo --version`, `cargo clippy --version`, `cargo fmt --version` | 1.88.0 / 1.88.0 / 0.1.88 / 1.8.0-stable |
| Sysroot packages | line count of `system/PKGS.txt` | 634 packages |
| Sysroot symlinks | `find /tmp/gtk-sysroot -xtype l` and `-type l -lname '/*'` | 0 broken library symlinks, 0 absolute symlinks |
| Sysroot architecture | `readelf -h` over every ELF in the sysroot | 1559 files, all `ELF 64-bit` `X86-64`, 0 bad |
| pkg-config modules | `pkg-config --modversion` for 37 modules | 37 of 37 print a version |
| Sysroot link check | `gcc` link of 19 libraries a symlink bug would break | link ok |
| Xvfb | `Xvfb :99 -screen 0 1280x800x24` against the sysroot libraries | started, then killed |
| Tools closure | `ldd` on `cmake`, `file`, `patchelf`, `pkgconf` | complete; every non-glibc dependency resolves inside the tree |
| Tools rpath | `env -i /tmp/tools/bin/<tool> --version` | 4 of 4 run with an empty environment |
| Tools versioned symlinks | `find /tmp/tools -xtype l` | 0 broken (an earlier copy left 40 dangling SONAME links; fixed) |
| Cargo vendor count | `ls /tmp/cargo-vendor` | 1114 package directories |
| Offline resolution | `CARGO_NET_OFFLINE=true cargo metadata --locked` for all seven manifests | 7 of 7 exit 0 |
| Path patches | `cargo tree -i block`, `-i sherpa-onnx-sys`, `-i rdev` | all three resolve from `/src/patches/` |
| Rust formatting | `cargo fmt --check` in six crates | 6 of 6 pass |
| Desktop clippy | `cargo clippy --locked -- -D warnings` | 0 warnings, finished in 6m 13s |
| Desktop lib tests | `cargo test --locked --lib` | 363 passed, 0 failed, 1 ignored |
| Transcription lib tests | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --lib` | 64 passed, 0 failed, 1 ignored |
| pill_shared tests | `cargo test --locked --manifest-path packages/rust_pill_shared/Cargo.toml` | 242 passed, 0 failed |
| GTK pill tests | `xvfb-run -a cargo test --locked --manifest-path packages/rust_gtk_pill/Cargo.toml` | 42 passed, 0 failed |
| Sidecar integration | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --test sidecar_integration` | 7 passed, 0 failed, 4 ignored |
| CI guard tests | `node --test scripts/ci/*.test.mjs` | 371 passed, 0 failed |
| Desktop TS unit | `pnpm --filter desktop run test:unit` | 3043 passed across 229 files |
| voice-ai tests | `pnpm --filter @maus-inc/voice-ai run test` | 501 passed across 37 files |
| agent tests | `pnpm --filter @repo/agent test` | 24 passed |
| preview tests | `pnpm --filter @maus-inc/preview test` | 22 passed across 4 files |
| Desktop lint | `pnpm --filter desktop run lint` | prettier, oxlint (0 warnings, 0 errors) and ui-lint all pass |
| Desktop types | `pnpm --filter desktop run check-types` | pass |
| Bindings | `bash scripts/check-bindings.sh` | regenerated, consistent, no diff |
| i18n | `pnpm --filter desktop i18n` then `git diff --exit-code` | in sync, no diff |
| App icons | `node scripts/generate-app-icons.mjs --check` | alpha, ICO frames and ICNS all OK |
| ONNX Runtime digest | `sha256sum onnxruntime-linux-x64-1.23.2.tgz` | `1fa4dcae…` matches the `build.rs` pin |
| sherpa-onnx digest | `sha256sum sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2` | `2ade8b7c…` matches the `build.rs` pin |
| Archive integrity | `tar tJf` / `tar tjf` on each reassembled archive | sysroot 35031 entries, vendor 64093, sherpa 17, ORT 36 |
| Tools architecture | `readelf -h` over every ELF in `system/tools` and `native/` | 48 files, all `ELF 64-bit` `X86-64`, 0 bad |
| Manifest | `sha256sum -c MANIFEST.sha256` after reassembly | 3871 of 3871 OK |

## Things the consumer must know

Each item below is a trap that cost real time to find. They are ordered roughly by how
much time they save.

### 1. `cargo --config` and `--offline` do not reach external subcommands

Cargo does not forward `--config` or `--offline` to external subcommands such as
`clippy` and `nextest`. Only built-ins like `check`, `metadata` and `tree` honour them.
A command like `cargo --offline --config <path> clippy` therefore silently ignores both
flags and tries to reach the network.

Use `$CARGO_HOME/config.toml` plus `CARGO_NET_OFFLINE=true` instead. `FETCH.md` does
exactly that.

### 2. `CARGO_BUILD_JOBS=1` is required for `cargo test`

A sandbox has about 3.9 GB of RAM and 2 cores with no swap. Parallel linking of the
large Tauri binaries gets the linker OOM-killed with `signal 9`. The repository's own
CI sets `CARGO_BUILD_JOBS=1` around the desktop `cargo test` step, and this branch was
verified with it set. Do not unset it to make the build faster.

### 3. The MSRV floor

`rust-toolchain.toml` pins `1.88.0`, and this branch ships exactly that, with a comment
in the file explaining that newer stable fails `cargo clippy -- -D warnings` and
`cargo test --lib` on this crate. None of the seven `Cargo.lock` files carry
`rust-version` fields, so the MSRV floor cannot be read out of the lockfile. The gate
run found no crate that requires a newer channel, so `--ignore-rust-version` is not
needed. Do not ship a newer toolchain: it changes clippy output, which is the whole
reason the pin exists.

### 4. The two native build payloads are mandatory, not optional

`packages/rust_transcription/build.rs` and `patches/sherpa-onnx-sys-1.13.5/build.rs`
both download from GitHub Releases. Without `MAUSVOICE_ORT_DYLIB_PATH` and
`SHERPA_ONNX_ARCHIVE_DIR` they try that download and fail after several minutes of
compiling. `FETCH.md` step 7 sets both. Details, including the full pinned digest
tables, are in `native/onnxruntime/ONNXRUNTIME.txt` and `native/sherpa-onnx/SHERPA.txt`.

Do not unset them mid-session. A later `cargo build` of `rust_transcription` will try
GitHub Releases again.

### 5. `CHROMEDRIVER_SKIP_DOWNLOAD=true` is mandatory for a scripts-enabled install

`chromedriver` is listed in `pnpm.onlyBuiltDependencies`, so its `install` script runs
under a normal `pnpm install --frozen-lockfile`. That script downloads from
`googlechromelabs.github.io` or `chromedriver.storage.googleapis.com`, neither of which
is reachable, and exits 1 on failure, which fails the whole install. Setting
`CHROMEDRIVER_SKIP_DOWNLOAD=true` makes it exit 0 immediately. Nothing in CI runs the
WebdriverIO suite, so the missing binary costs nothing.

### 6. The `--ignored` sidecar integration tests cannot run

`tests/sidecar_integration.rs` has `--ignored` tests that download model weights from
`huggingface.co`, which is unreachable. Sizes run from 77 MB to 3.1 GB. This is
expected and matches CI's own note that those tests download model artifacts. The
non-ignored tests in that file do run. Whisper model URLs are overridable with
`RUST_TRANSCRIPTION_MODEL_URL_<UPPERCASE_ID>`; the ONNX and SenseVoice URLs are
deliberately not runtime-overridable.

### 7. Node version

The sandbox has Node v22.22.3. `.nvmrc` says `v24`, which the sandbox does not have, but
nothing enforces `.nvmrc` outside GitHub Actions (`node-version-file: .nvmrc`), and
`engine-strict` is not set. The root `package.json` `engines` field allows v22.22.2 or
newer, so v22.22.3 satisfies it. Do not "fix" the mismatch.

### 8. `whisper-rs-sys` carries the whisper.cpp source inside the crate

`whisper-rs-sys 0.14.1` ships its C++ tree inside the crates.io package, so no separate
`native/whisper.cpp/` group is needed and `G-5b` builds it with the `cmake` crate.
Confirmed by `ls /tmp/cargo-vendor/whisper-rs-sys-0.14.1/`, which shows a `whisper.cpp`
directory beside `build.rs` and `wrapper.h`. The spec left this as its only open
question; it resolves in the cheaper direction.

### 9. Some integration tests need `GROQ_API_KEY` and cannot run here

`pnpm --filter desktop run test:integration` runs `vitest run test/integration`, and
`test/integration/post-processing-stability.test.ts` and
`test/integration/transcription.test.ts` both fail fast with
`Missing required environment variable: GROQ_API_KEY`. The repository's own
`AGENTS.md` Verification Gate notes this: *"all unit tests; GROQ_API_KEY integration
tests may be unavailable"*. Set the key or skip the gate. Nothing else in that suite
fails.

### 10. `file` needs `MAGIC` set to classify files

`file --version` works from the tree with no environment, which is what gate `G-0d`
checks. Classifying a file is separate: Debian's `file` looks for its database at the
compiled-in `/usr/share/misc/magic.mgc`, which does not exist in a sandbox, so
`file -b <path>` prints `could not find any valid magic files!`. The database is on the
branch at `system/tools/share/magic.mgc` (8.3 MB, the upstream `libmagic-mgc` file).
Point `MAGIC` at it:

```bash
MAGIC=/tmp/tools/share/magic.mgc /tmp/tools/bin/file -b some.bin
```

The reference branch ships the same file in the same place and also leaves `MAGIC`
unset, so this matches it. Nothing in this repository's scripts calls `file`, so the
default only matters if you use it interactively.

### 11. Extract to `/tmp` only

The sandbox persists only files under its workspace root, and turn-end artifacts are
capped at roughly 128 MB and 10,000 files. A 1 GB payload extracted into the workspace
blows that. Download and extract in `/tmp`, and delete the downloaded tarball once the
archives are reassembled.

### 12. `strict-peer-dependencies=true`

`.npmrc` sets `strict-peer-dependencies=true`, so a peer mismatch fails the install. If
`pnpm install --frozen-lockfile` errors on peers, that is the cause, not the vendor
tree.

### 13. `block` is both vendored and path-patched

`block 0.1.6` is a real crates.io dependency of `cocoa`, so `cargo vendor` includes it,
while `apps/desktop/src-tauri/Cargo.toml` also patches it to `patches/block-0.1.6`. The
path patch wins at resolve time for the desktop crate. This was verified with
`cargo tree -i block`, which shows `block v0.1.6 (/src/patches/block-0.1.6)`.

`sherpa-onnx-sys` and `rdev` are **not** in the vendor tree at all, which is correct:
they are in-repo path patches and path dependencies, and `cargo vendor` does not vendor
them. Do not delete `patches/`.

## Provenance

Per artifact: upstream URL, upstream published hash where one exists, and the exact
command used.

### Rust 1.88.0 components

Downloaded from `https://static.rust-lang.org/dist/<component>-1.88.0-x86_64-unknown-linux-gnu.tar.xz`
and `https://static.rust-lang.org/dist/channel-rust-1.88.0.toml`. Each file's sha256 was
verified against the `xz_hash` that `channel-rust-1.88.0.toml` publishes for it.

| File | sha256 (upstream `xz_hash`, verified) |
| --- | --- |
| `rustc-1.88.0-x86_64-unknown-linux-gnu.tar.xz` | `b049fd57fce274d10013e2cf0e05f215f68f6580865abc52178f66ae9bf43fd8` |
| `rust-std-1.88.0-x86_64-unknown-linux-gnu.tar.xz` | `36d7eacf46bd5199cb433e49a9ed9c9b380d82f8a0ebc05e89b43b51c070c955` |
| `cargo-1.88.0-x86_64-unknown-linux-gnu.tar.xz` | `856962610ee821648cee32e3d6abac667af7bb7ea6ec6f3d184cc31e66044f6b` |
| `rustfmt-1.88.0-x86_64-unknown-linux-gnu.tar.xz` | `55f4c150a865cae19cfa5f5f2b5eec84ed98dc3a1c1c406d4323c63d896c3f1d` |
| `clippy-1.88.0-x86_64-unknown-linux-gnu.tar.xz` | `db09c9e4a8a0b486781d87403f74a203a58d9ef0a58ba10c39264916d93ac603` |

Note that `channel-rust-1.88.0.toml` keys these as `rustfmt-preview` and
`clippy-preview`, not `rustfmt` and `clippy`.

### Cargo vendor tree

Produced by one `cargo vendor --locked --versioned-dirs` invocation with
`--manifest-path apps/desktop/src-tauri/Cargo.toml` and six `--sync` arguments, in a
`debian:12` container with the Rust 1.88.0 toolchain above. Sources are crates.io plus
one git source, `ferrous-focus 0.4.1` from
`git+https://github.com/MichaelWGibson/ferrous-focus#3816f6a1214240b801c32e05c1abdff3b784b15f`.

The resulting `cargo-config.toml` has three source stanzas: the `crates-io`
replacement, the `ferrous-focus` git replacement, and `vendored-sources` pointing at
`/tmp/cargo-vendor`. Unlike the older `better-Shape/app` reference branch, this one has
a git stanza, and flattening it away breaks offline resolution of the git dependency.

`rust/Cargo.lock.sha256` lists all seven lockfiles. The consumer runs
`sha256sum -c rust/Cargo.lock.sha256` from the repository root and should refuse to
build on any mismatch, because a vendor tree built against different lockfiles resolves
offline to the wrong versions.

| Lockfile | sha256 |
| --- | --- |
| `apps/desktop/src-tauri/Cargo.lock` | `b97457241ba33dbc2801592bbb885fc324c8c7a3fa8a35016585dfcef3596d09` |
| `apps/windows-installer/src-tauri/Cargo.lock` | `52c46c5acf9a010074ec7aa35f2a25e9fc8b4313a599ec58608c81d1195eb54d` |
| `packages/rust_gtk_pill/Cargo.lock` | `a77ee040b276204ea904d60c643eb6df876c0a8edbe293f5da1a545adfccc502` |
| `packages/rust_macos_pill/Cargo.lock` | `d52f9ad2aa16e9f950293c0a8789eca9106a84eb0bf24dae1237193a472e8c4e` |
| `packages/rust_pill_shared/Cargo.lock` | `fe6f4c1c7b138939c221ebe28762d0144fe80b2f0a63f4adecde29bff2a535cd` |
| `packages/rust_transcription/Cargo.lock` | `3611a2fc2201f408527bb19f2d1f9487a6bd25dcf824693848151cecaa94731b` |
| `packages/rust_windows_pill/Cargo.lock` | `ac064090df74395b85deb1aee7e2b59a4608c64333232b874116530c35626a0f` |

### Debian 12 development sysroot

Built in a clean `debian:12` container (glibc 2.36-9+deb12u14) by installing the apt
set listed below, removing `/etc/apt/apt.conf.d/docker-clean` first so that
`/var/cache/apt/archives` survives, then extracting every `.deb` with
`dpkg-deb -x` into one tree, then running `fix-sysroot-links.py`, then `tar -cJf`.

`system/PKGS.txt` records `Package: <name>` and `Version: <version>` for each of the
634 `.deb` files folded in, tab separated, one per line.

The apt set:

```
build-essential pkg-config pkgconf cmake patchelf file curl wget git
clang libclang-dev llvm
libgtk-3-dev libglib2.0-dev libcairo2-dev libpango1.0-dev
libgdk-pixbuf-2.0-dev libharfbuzz-dev libatk1.0-dev libatk-bridge2.0-0
libatspi2.0-dev libepoxy-dev libgl-dev libgles-dev libegl-dev libopengl-dev
libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
libayatana-appindicator3-dev librsvg2-dev libgtk-layer-shell-dev
libasound2-dev libpulse-dev libunwind-dev libxdo-dev libudev-dev
libssl-dev libdbus-1-dev libffi-dev uuid-dev zlib1g-dev libzstd-dev
liblzma-dev libbz2-dev
libx11-dev libxext-dev libxrandr-dev libxi-dev libxcursor-dev libxinerama-dev
libxtst-dev libxcb1-dev libxcb-render0-dev libxcb-shm0-dev libxkbcommon-dev
libwayland-dev libwayland-bin wayland-protocols
libenchant-2-dev
libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev
gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
xvfb xauth imagemagick
webkit2gtk-driver
python3 python3-distutils
```

Two corrections to the original build specification, both measured here:

* `webkit2gtk-driver` is required and was missing from the list. `WebKitWebDriver`
  lives in that package at `/usr/bin/WebKitWebDriver`, **not** inside
  `libwebkit2gtk-4.1-0`. On Linux the WebdriverIO config drives the app through
  `tauri-driver`, which needs `WebKitWebDriver`.
* `ca-certificates` is required for any HTTPS access from inside the container. A bare
  `debian:12` image has no CA bundle, so `curl https://…` fails with
  `error setting certificate file: /etc/ssl/certs/ca-certificates.crt`. It is part of
  the base payload here.

`fix-sysroot-links.py` (shipped at `system/build/fix-sysroot-links.py` so the sysroot
can be rebuilt from scratch) does four things. Debian 12 is usr-merged, so `/lib`, `/bin`
and `/sbin` are symlinks into `/usr`, but `dpkg-deb -x` creates **real directories** at
those paths. Runtime SONAMEs such as `libexpat.so.1` therefore land under `lib/`, off the
linker search path, and linking the Tauri stack fails with an undefined reference.

1. Folds `lib`, `lib64`, `bin` and `sbin` into `usr`, replacing each with the symlink
   the base image ships.
2. Rewrites every absolute symlink to a relative one.
3. Supplies any missing symlink target from the base image, so `-lX` resolves. This
   covers `libudev.so.1`, whose `.so` symlink points at a SONAME that lives in another
   package.
4. Deletes static archives that shadow a shared library of the same name. 109 were
   removed. Those archives are the trap that turns a symlink problem into a link error,
   and nothing in this build links them statically.

### `system/tools/`

`cmake` 3.25.1, `file` 5.44, `patchelf` 0.14.3 and `pkgconf` 1.8.1, each with a
complete library closure. `system/tools/bin/pkg-config` is a symlink to `pkgconf` in
the same directory; copy the whole tree, not individual files.
`system/tools/share/cmake-3.25` carries cmake's module and template tree, which `cmake`
needs at run time.

The closure was built by walking the `NEEDED` graph of each executable with `readelf`,
copying the real file behind every SONAME into `lib/`, and recreating each SONAME
symlink. 44 libraries were copied and no SONAME was left unresolved. Each executable
carries `DT_RPATH=$ORIGIN/../lib`, set with `patchelf --force-rpath`.

`DT_RPATH` rather than `DT_RUNPATH` is deliberate. A `DT_RUNPATH` applies only to the
lookups of the object that declares it and is not inherited, so a binary's runpath finds
its direct libraries but not their transitive dependencies, which then silently fall
back to system paths. `DT_RPATH` is inherited down the chain when no intermediate object
declares its own `RUNPATH`, and Debian libraries do not. One tag per executable is
therefore enough, and no bundled library has to be rewritten.

The glibc family (`libc`, `libm`, `libdl`, `libresolv`, `libpthread`, `librt`, `libnsl`,
`libutil`) is deliberately **not** bundled, and neither is `ld-linux-x86-64.so.2`. The
kernel picks the dynamic loader from the ELF interpreter path, not from rpath, so a
bundled loader is unreachable, and a bundled older glibc running under a newer host
loader is a well known source of strange runtime failures. Every Linux host already has
glibc, so this costs nothing.

An earlier revision of this tree copied only the SONAME symlinks and not their versioned
targets. That left 40 dangling links, and `ldd` quietly resolved those dependencies
against the container's own system libraries, so the tree looked self-contained while it
was not. The current tree has zero broken symlinks and resolves every non-glibc
dependency from inside itself.

One measured quirk: `patchelf` 0.14.3 segfaults when rewriting `libgcc_s.so.1`. The
closure builder avoids this by only ever patching the four executables, and by using the
system `patchelf` so that `patchelf` is not rewriting itself while it runs.

### ONNX Runtime 1.23.2

`native/onnxruntime/onnxruntime-linux-x64-1.23.2.tgz` from
`https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-linux-x64-1.23.2.tgz`,
sha256 `1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b`, which is the
value `packages/rust_transcription/build.rs` pins and which the download matched. MIT.
Full details in `native/onnxruntime/ONNXRUNTIME.txt`.

### sherpa-onnx v1.13.5

`native/sherpa-onnx/sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2` from
`https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.5/sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2`,
sha256 `2ade8b7c62de66b9cf2e32bd7dbe077addaa4b18f422b49dc1bf3a1a0b1f762e`, which is the
value `patches/sherpa-onnx-sys-1.13.5/build.rs` pins and which the download matched.
Apache-2.0. Full details, including the complete digest table for the archives that
were **not** vendored, in `native/sherpa-onnx/SHERPA.txt`.

### Licences

`LICENSES/debian/<package>/copyright` holds the `usr/share/doc/<package>/copyright`
text for 605 of the 634 packages in `PKGS.txt`, one file per package directory, each
named `copyright`. The 29 packages without one are virtual or metapackages such as
`build-essential`, which ship no copyright file.

Also on this branch, because they are redistributions the older reference branch did
not carry:

* `LICENSES/onnxruntime/LICENSE` (MIT) and `ThirdPartyNotices.txt`, extracted from the
  ONNX Runtime archive. The MIT text is byte-identical to
  `apps/desktop/src-tauri/binaries/onnxruntime/LICENSE.txt` in the repository.
* `LICENSES/sherpa-onnx/LICENSE` (Apache-2.0), from
  `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.5/LICENSE`. The prebuilt
  archive ships no licence file of its own.
* `LICENSES/whisper.cpp/LICENSE` (MIT), extracted from the `whisper.cpp/LICENSE` inside
  the `whisper-rs-sys 0.14.1` crate.

The GTK, GLib, WebKit, cairo and pango stack is LGPL and permissive, and the Debian
package copyright texts are authoritative for it. Every package extracted into the
sysroot and into `system/tools/` has its `usr/share/doc/<package>/copyright` at
`LICENSES/debian/<package>/copyright`.

## Manifest

`MANIFEST.sha256` is in `sha256sum` format, `<64 hex><two spaces><relative path>`. It
covers every file in the tree, and it lists each split archive a second time under its
**reassembled** name, which is what lets the reassembly one-liner in `FETCH.md` know
which files to join.

Verify after reassembly with `sha256sum -c MANIFEST.sha256`. It must report every line
OK with zero failures.

## Size notes

The largest extracted consumers are the sysroot at 1.94 GB and the cargo vendor tree at
1.73 GB. The Rust toolchain unpacks to 602 MB. Together with the payloads and a
`target/` directory, plan on about 4.5 GB for the payload plus several GB for build
output.

The vendor tree is larger than a first estimate would suggest because it carries five
major versions of the `windows` crate (`0.51.1`, `0.52.0`, `0.54.0`, `0.58.0`,
`0.61.3`) plus their `windows-sys`, `windows-targets` and `winapi-*-pc-windows-gnu`
companions, roughly 985 MB together, all of it dead weight on Linux but required
because `cargo vendor` vendors the whole dependency graph.

## Rebuilding and force-pushing

This is an orphan branch with a single commit and no parents, and nothing consumes its
history. Force-pushing a rebuilt payload is acceptable and expected:

```
git push --force-with-lease origin vendor/sandbox-toolchain
```

## Provenance of this branch

Built and pushed by an agent (MausAgent) working on `maus-inc/mausVoice`. The commit
message is `vendor: sandbox toolchain payload (G1-G8)`. The payload mirrors the shape
of the `better-Shape/app` branch `vendor/sandbox-toolchain` at commit
`7c4c8788b138294d1a9be31dbee79075df5e7f3d`, adapted for this repository's seven Cargo
workspaces, its Rust 1.88.0 pin, its WebdriverIO rather than Playwright setup, and its
two GitHub Release build-time downloads.

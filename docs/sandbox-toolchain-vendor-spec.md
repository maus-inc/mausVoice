# Spec: `vendor/sandbox-toolchain` orphan branch for `maus-inc/mausVoice`

**Status:** build specification, handed to an agent with unrestricted internet.
**Author of spec:** an agent running inside the restricted sandbox, so every statement
about the sandbox below was *measured there*, not assumed.
**Reference implementation:** `better-Shape/app`, branch `vendor/sandbox-toolchain`,
commit `7c4c8788b138294d1a9be31dbee79075df5e7f3d` ("vendor: sandbox toolchain payload
(G1-G4)", 2026-10-16, author `mausagent <mausAgent@proton.me>`). That branch was read
in full via the GitHub API; its `README.md`, `FETCH.md`, `MANIFEST.sha256`,
`system/PKGS.txt`, `system/tools/TOOLS.txt`, `browsers/BROWSERS.txt`,
`chrome-deps/cft-156/PACKAGES.txt`, `rust/cargo-config.toml` and `rust/Cargo.lock.sha256`
are quoted or summarised below.

## Corrections after the build

The branch was built on 2026-10-28 and amended on 2026-10-29. Four statements in this
spec are wrong. The implementation is correct and this spec was wrong in each case.
Read this list before following anything below, because the wrong text is left in place
so the divergence stays visible rather than being quietly rewritten.

1. **The git source key carries no revision fragment.** Section 6.2.2 shows
   `[source."git+https://github.com/MichaelWGibson/ferrous-focus#3816f6a..."]`. The
   `rust/cargo-config.toml` on the pushed branch reads
   `[source."git+https://github.com/MichaelWGibson/ferrous-focus"]`, with no `#`
   fragment. Cargo keys a source by its canonical URL, so adding the revision makes the
   replacement silently fail to match.

2. **`/tmp/cargo-vendor/block-0.1.6` must exist, not be absent.** Section 6.2.3 asks
   `ls -d /tmp/cargo-vendor/block-0.1.6 ...` to report "No such file". That is wrong.
   `block 0.1.6` is a genuine crates.io dependency of `cocoa`, so the directory is
   expected even though `[patch.crates-io]` points the desktop crate at
   `patches/block-0.1.6`. The path patch still wins at resolve time. The corrected
   statement is recorded in `engineering/sandbox-vendor-handoff-prompt.md`.

3. **The size cap is "no file exceeds 90 MiB", not "every file is under 90 MiB".**
   Section 1 says "Every file < 90 MiB". Under `split -b 90m` every full part is exactly
   94,371,840 bytes, which is not less than 90 MiB. Measured on the pushed branch, three
   parts are exactly 94,371,840 B and the two remainder parts are 37,571,332 B and
   39,438,244 B.

4. **The packed size estimate is high by about a third.** Section 1 says to expect 1.0 to
   1.4 GB packed and Section 5 says about 0.9 to 1.1 GB. The branch is 798,761,772 bytes
   across 3870 files, which is 798.8 MB at 10^6 bytes per MB. Every per-directory number
   in the branch README was re-derived from the git tree on 2026-10-29 and matches.

None of these change what the payload contains, and none of them invalidate the gates.
The branch is correct. The spec's arithmetic and two of its command snippets were not.

---

## 0. Read this first: what you are building and what you are NOT

You are building an **orphan git branch** on `maus-inc/mausVoice` named
`vendor/sandbox-toolchain`. It carries **no source code**. It carries only binaries,
archives and source trees that a network-restricted agent sandbox cannot fetch for
itself, so that the sandbox can run this repo's real verification gates
(`cargo clippy`, `cargo test`, `cargo fmt`, `pnpm install`, `vitest`, `tsc`) through
the git protocol alone.

It is **not** based on `main`. It must **never** be merged into `main`. It must
**never** be opened as a pull request. It must never enter a release or CI workflow.
A sandbox fetches it, extracts it to `/tmp`, uses it, and deletes it.

Two things make this a *recreation*, not a copy:

1. The reference branch was built for a **different repository** (`better-Shape/app`:
   Next.js + one `src-tauri` at the root, Playwright for E2E, 759 crates, one
   Cargo workspace). mausVoice is a **pnpm Turborepo with seven separate Cargo
   workspaces** (1124 distinct vendored packages), **no Playwright** (WebdriverIO +
   `chromedriver` + `tauri-driver`, and the wdio suite is not wired into CI at all),
   and — the big one — **two build scripts that download native payloads from GitHub
   Releases at build time** (`sherpa-onnx-sys` and `packages/rust_transcription`).
   Those downloads are the reason the reference branch's contents are necessary but
   **not sufficient** here.
2. The reference branch pins **Rust 1.89.0**. mausVoice pins **Rust 1.88.0** in
   `rust-toolchain.toml`, deliberately, with a comment explaining that current stable
   fails `cargo clippy -- -D warnings` and `cargo test --lib` on this crate. Ship
   1.88.0. See §3.1 for the one risk that creates and how to detect it.

Section 12 is a decision list. Read it before you start; three of the decisions change
what you build.

---

## 1. Deliverable contract (non-negotiable)

| Property | Required value |
| --- | --- |
| Repo | `maus-inc/mausVoice` |
| Branch name | `vendor/sandbox-toolchain` (exactly; the sandbox docs will hardcode it) |
| History | **Orphan.** `git checkout --orphan`, zero parents, **one** commit |
| Commit message | `vendor: sandbox toolchain payload (G1-G8)` |
| Mergeable | Never. No PR, no merge, no rebase onto `main` |
| Base | None. Do not branch from `main` |
| Git LFS | **Not used.** This repo has no LFS (`.gitattributes` carries only two rules: `-whitespace` on `packages/desktop-native-apis/src/bindings.ts` and `*.sql text eol=lf`). Do not introduce LFS |
| Per-file size cap | **Every file < 90 MiB.** GitHub rejects pushes over 100 MiB. The reference branch splits at exactly `94371840` bytes (= 90 MiB) |
| Split naming | `<asset>.part-00`, `<asset>.part-01`, … zero-padded two digits, ascending, produced by `split -b 90m` |
| Total payload | Reference branch: 880 MB packed / 3777 files. Expect **1.0–1.4 GB packed** here (§5 sizes the delta) |
| Manifest | `MANIFEST.sha256` at the branch root, `sha256sum` format (`<64 hex><two spaces><relative path>`), covering **every** file in the tree **plus** each split archive listed a second time under its **reassembled** name |
| Docs | `README.md` and `FETCH.md` at the branch root (§8, §9) |
| Source code | **None.** No `apps/`, no `packages/`, no `.github/`. Nothing here is imported by the application at build or run time |
| Extract location | Consumers extract to `/tmp` only, never into the workspace (the workspace is snapshotted; see §2) |

---

## 2. The consuming sandbox — measured ground truth

All of this was measured inside the sandbox that will consume your branch, on
2026-10-28. **Re-measure before you finalise**; the numbers are the reason for most
decisions below.

### 2.1 Platform

```
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"     VERSION_ID="12"   CODENAME=bookworm
glibc 2.36   (Debian GLIBC 2.36-9+deb12u14)
arch  x86_64        kernel 6.1.158+
CPU   2 cores  (nproc = 2)
RAM   3939 MB total, 0 swap        <-- "the 3.9 GB a sandbox has"
Disk  /dev/root 21G, 19G available, mounted at / (so /tmp has ~19 GB)
```

Two consequences you must design for:

- **3.9 GB RAM, 2 cores, no swap.** Parallel linking of large Tauri binaries gets the
  linker OOM-killed with `signal 9`. The reference branch hit exactly this and its
  fix is `CARGO_BUILD_JOBS=1` for `cargo test`. Assume you need it here too — see
  §10 gate G-4.
- **~19 GB free disk.** The reference payload is 3.7 GB extracted. mausVoice's is
  larger (§5) and a full `cargo build` of `apps/desktop/src-tauri` plus
  `packages/rust_transcription` adds several more GB of `target/`. It fits, but only
  if nothing is extracted into the workspace and the vendor tarball is deleted after
  extraction. Say so loudly in `README.md`.

### 2.2 Network allowlist

Outbound access is limited to exactly these hosts:

```
github.com
codeload.github.com
api.github.com
registry.npmjs.org
pypi.org
files.pythonhosted.org
```

**The trap that drives most of this spec:** `github.com` *is* allowed, but a GitHub
**Release asset download** is a 302 redirect to `objects.githubusercontent.com`, which
is **not** allowed. So "it's on GitHub" does **not** mean "the sandbox can download it."
Both of mausVoice's build-time native downloads are GitHub Release assets (§6.5). They
will fail, and they will fail late — after cargo has compiled several hundred crates —
unless the branch supplies the payloads and the consumer sets the override env vars.

Equally: `static.rust-lang.org`, `deb.debian.org`, `cdn.playwright.dev`,
`googlechromelabs.github.io`, `chromedriver.storage.googleapis.com`, `huggingface.co`,
`sh.rustup.rs`, `crates.io`, `nodejs.org` are all **unreachable**.

### 2.3 Tools present / absent (measured)

| Present | Version |
| --- | --- |
| `git` | 2.39.5 |
| `curl`, `wget` | — |
| `tar`, `xz`, `gzip`, `bzip2`, `unzip` | — |
| `gcc`, `g++`, `cc`, `make` | gcc 12.2.0 (Debian 12.2.0-14+deb12u1) |
| `python3` | 3.11.2 |
| `node` | **v22.22.3** |
| `npm` | 10.9.8 |
| `corepack` | present |
| `yarn` | present |
| `sha256sum`, `jq` | — |
| `readelf`, `ldd`, `objdump`, `strip`, `ar` | binutils, present |
| `gh` | 2.23.0 |

| **Absent — your branch must supply or work around** | Needed by |
| --- | --- |
| `cargo`, `rustc`, `rustup` | every Rust gate → **G1** |
| `cmake` | `whisper-rs-sys` builds bundled whisper.cpp via the `cmake` crate → **G4** |
| `pkg-config`, `pkgconf` | every GTK/WebKit `*-sys` crate → **G4** |
| `patchelf` | rpath fixups → **G4** |
| `file` | `file` crate / diagnostics → **G4** |
| `clang`, `libclang` | **`bindgen` 0.71.1 and 0.72.1** are in the dependency union (`clang-sys` 1.8.1/1.9.1). `whisper-rs-sys` and `ort-sys` use bindgen → **G3** (this is the single biggest delta from the reference sysroot, which has no clang at all) |
| `pnpm` | the entire JS half. Recoverable **without** your branch: `corepack` is present and `registry.npmjs.org` is allowed, so `corepack enable && corepack prepare pnpm@10.34.5 --activate`, or `npm i -g pnpm@10.34.5`. Document this in `FETCH.md`; do **not** vendor Node/pnpm unless §12 D-3 says otherwise |
| `zstd`, `7z` | nothing in this repo needs them — but it means **you must pack with `xz`, never `zstd`** |
| `xvfb-run`, `Xvfb` | `release.yml` runs `xvfb-run -a cargo test --manifest-path packages/rust_gtk_pill/Cargo.toml` → **G3** (see §12 D-4) |
| `bun` | `build-desktop.yml` runs `oven-sh/setup-bun@…` with `bun-version: 1.3.6`, but **nothing in the repo actually invokes `bun`** (the only hits are `scripts/ci/check-workflow-pins.test.mjs` asserting the action pin, and regex literals in `release-shell-contracts.test.mjs`). Do **not** vendor bun |
| GTK/WebKit/ALSA/PulseAudio/layer-shell dev headers+libs | → **G3** |

Node v22.22.3 satisfies root `package.json` `engines: "^22.22.2 || ^24.15.0 || >=26.0.0"`.
`.nvmrc` says `v24`, which the sandbox does **not** have; nothing enforces `.nvmrc`
outside GitHub Actions (`node-version-file: .nvmrc`), and `engine-strict` is not set
(`.npmrc` contains only `strict-peer-dependencies=true`). So **no Node vendoring is
required** — but record the v24/v22 mismatch in `README.md` so nobody "fixes" it later.

### 2.4 Snapshot budget

The sandbox persists only files under its workspace root, and turn-end patchset
artifacts are capped (~128 MB combined / ~10,000 files). A ~1 GB payload or a
`git fetch` that grows `.git` inside the workspace will blow that. Hence: **extract to
`/tmp`, never into the workspace**, and **never `git fetch` the vendor branch into the
workspace clone** — download it to `/tmp` with `codeload` or a separate `/tmp` clone.
This repo's `.gitignore` already reserves `.tooling/` ("Locally installed Rust
toolchain (CARGO_HOME/RUSTUP_HOME for local gates). Never committed") and `/temp`,
`target/`, `.toolchain/` — but the rule is still: keep it all in `/tmp`.

---

## 3. Rust toolchain requirements (from this repo, measured)

### 3.1 The pin

`rust-toolchain.toml` (repo root):

```toml
# Pin the desktop clippy/test toolchain. Latest stable started failing
# `cargo clippy -- -D warnings` and `cargo test --lib` on this crate
# (exit 101) across Linux/macOS/Windows. 1.88 is new enough for Tauri 2
# and old enough to avoid the current stable lint/API churn.
[toolchain]
channel = "1.88.0"
components = ["clippy", "rustfmt"]
```

→ **Ship Rust 1.88.0**, components `rustc`, `rust-std`, `cargo`, `rustfmt`, `clippy`.

Every CI job installs with `dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable`,
but rustup honours the in-repo `rust-toolchain.toml`, so CI effectively runs 1.88.0.
Matching the pin is what keeps `cargo clippy -- -D warnings` green.

**The risk, and how to detect it.** None of the seven `Cargo.lock` files carry
`rust-version` fields (measured: zero matches — the resolver here is not MSRV-aware, so
the lockfile records nothing). That means you **cannot** read the MSRV floor out of the
lock the way the reference branch could (its README names `notify-rust@4.18.0` as the
only crate demanding 1.89). mausVoice has no `notify-rust` at all. So:

- Build the 1.88.0 payload.
- **Then** run gate G-1 (§10). If any crate fails with
  `package X requires rustc 1.NN or newer`, that is your MSRV floor: rebuild the branch
  with that channel, record the crate name and required version in `README.md` under
  "Things the consumer must know", and note whether `--ignore-rust-version` is needed
  instead. Do not silently ship a newer toolchain than `rust-toolchain.toml` names —
  it changes clippy results, which is the whole reason the pin exists.

### 3.2 The seven Cargo workspaces

There is **no root Cargo workspace** (measured: zero `[workspace]` declarations). Seven
independent manifests, each with its own committed `Cargo.lock` (lockfile `version = 4`):

| Manifest | Package name | `Cargo.lock` sha256 | `[[package]]` entries |
| --- | --- | --- | --- |
| `apps/desktop/src-tauri/Cargo.toml` | `mausVoice` 0.1.6 | `b97457241ba33dbc2801592bbb885fc324c8c7a3fa8a35016585dfcef3596d09` | 906 |
| `apps/windows-installer/src-tauri/Cargo.toml` | `mausvoice-installer` 0.1.6 | `52c46c5acf9a010074ec7aa35f2a25e9fc8b4313a599ec58608c81d1195eb54d` | 497 |
| `packages/rust_transcription/Cargo.toml` | `rust_transcription` 0.1.0 | `3611a2fc2201f408527bb19f2d1f9487a6bd25dcf824693848151cecaa94731b` | 314 |
| `packages/rust_gtk_pill/Cargo.toml` | `rust_gtk_pill` 0.1.0 | `a77ee040b276204ea904d60c643eb6df876c0a8edbe293f5da1a545adfccc502` | 90 |
| `packages/rust_macos_pill/Cargo.toml` | `rust_macos_pill` 0.1.0 | `d52f9ad2aa16e9f950293c0a8789eca9106a84eb0bf24dae1237193a472e8c4e` | 27 |
| `packages/rust_windows_pill/Cargo.toml` | `rust_windows_pill` 0.1.0 | `ac064090df74395b85deb1aee7e2b59a4608c64333232b874116530c35626a0f` | 24 |
| `packages/rust_pill_shared/Cargo.toml` | `rust_pill_shared` 0.1.0 | `fe6f4c1c7b138939c221ebe28762d0144fe80b2f0a63f4adecde29bff2a535cd` | 1 |

Two more `Cargo.lock` files exist inside patched crates and are **not** vendor roots
(each has 1 entry): `patches/block-0.1.6/Cargo.lock`
(`dcdf41a5339bd2cf0cadc3e3d664c963c6bfea62d5b9b11e2f8a968f4b1dab03`) and
`patches/rdev/Cargo.lock` (`dbdfae50668682fa4caad6021f6d315aa37a1d0d68f369385b337d774a8f9f32`).

**Union across all seven: 1124 distinct `(name, version, source)` packages** —
1113 from `registry+https://github.com/rust-lang/crates.io-index`, **1 from git**, and
10 path/local (never vendored):

```
git:   ferrous-focus 0.4.1
       git+https://github.com/MichaelWGibson/ferrous-focus#3816f6a1214240b801c32e05c1abdff3b784b15f
path:  block, mausVoice, mausvoice-installer, rdev, rust_gtk_pill, rust_macos_pill,
       rust_pill_shared, rust_transcription, rust_windows_pill, sherpa-onnx-sys
```

The reference branch's provenance note says "no git dependencies and no patches".
**Both statements are false here.** This is the most important structural difference
and it changes the `cargo vendor` invocation (§6.2) and the shape of
`rust/cargo-config.toml` (§6.2.4).

### 3.3 `[patch.crates-io]` sections (two)

```toml
# apps/desktop/src-tauri/Cargo.toml:157
[patch.crates-io]
block = { path = "../../../patches/block-0.1.6" }

# packages/rust_transcription/Cargo.toml:74
[patch.crates-io]
sherpa-onnx-sys = { path = "../../patches/sherpa-onnx-sys-1.13.5" }
```

Plus a path dependency that is not a patch:

```toml
# apps/desktop/src-tauri/Cargo.toml
rdev = { path = "../../../patches/rdev" }   # "Local fork that restores macOS event taps"
```

Consequences:

- The patched/forked crates live **in the repository**, so the vendor tree must not try
  to supply them, and the consumer must not delete them.
- `sherpa-onnx-sys` is patched to **version 1.13.5 with a 1854-line `build.rs`** that
  pins digests and does the GitHub-Release download (§6.5). Vendoring does not remove
  that download; the env override does.
- `cargo vendor` with a `[patch.crates-io]` pointing at a local path is a known source
  of friction ("found duplicate versions of package …"). Verify, don't assume — §6.2.3.

### 3.4 Native-binding crates in the union → the system-library surface

This is what **G3** (sysroot) has to satisfy. Extracted from the union of all seven
locks:

| Crate (version) | Debian 12 package(s) required |
| --- | --- |
| `gtk-sys`, `gdk-sys`, `atk-sys`, `gio-sys`, `glib-sys`, `gobject-sys`, `cairo-sys-rs`, `pango-sys`, `pangocairo-sys`, `gdk-pixbuf-sys` | `libgtk-3-dev`, `libglib2.0-dev`, `libcairo2-dev`, `libpango1.0-dev`, `libgdk-pixbuf-2.0-dev`, `libatk1.0-dev`, `libatk-bridge2.0-0`, `libatspi2.0-dev` |
| `gdkwayland-sys`, `wayland-sys`, `wayland-client`, `wayland-protocols`, `wayland-scanner` | `libwayland-dev`, `libwayland-bin`, `wayland-protocols`, `libxkbcommon-dev` |
| `gdkx11-sys`, `x11` 2.21.0, `x11-dl`, `x11rb` | `libx11-dev`, `libxext-dev`, `libxrandr-dev`, `libxi-dev`, `libxcursor-dev`, `libxcb1-dev`, `x11proto-dev` |
| `webkit2gtk-sys` 2.0.2 | `libwebkit2gtk-4.1-dev` |
| `javascriptcore-rs-sys` 1.1.1 | `libjavascriptcoregtk-4.1-dev` |
| `soup3-sys` 0.5.0 | `libsoup-3.0-dev` |
| `libappindicator-sys` 0.9.0 | `libayatana-appindicator3-dev`, `libdbusmenu-gtk3-dev` |
| **`gtk-layer-shell-sys` 0.7.2** | **`libgtk-layer-shell-dev`** — *absent from the reference sysroot* |
| **`alsa-sys` 0.3.1**, `alsa` 0.9.1 | **`libasound2-dev`** — reference has runtime `libasound2` only |
| **`libpulse-sys` 1.23.0**, **`libpulse-simple-sys` 1.22.0** | **`libpulse-dev`** — reference has runtime `libpulse0` only |
| `openssl-sys` 0.9.117, `openssl` 0.10.81 | `libssl-dev`, `pkg-config` |
| **`bindgen` 0.71.1 + 0.72.1**, `clang-sys` 1.8.1 + 1.9.1 | **`clang`, `libclang-dev`** — *absent from the reference sysroot; ~250 MB on disk* |
| `cmake` crate 0.1.58 | `cmake` (via **G4**) |
| `cc` 1.2.59 + 1.4.3, `bzip2-sys`, `libsqlite3-sys` 0.30.1 (bundled), `onig_sys` 69.9.3 (bundled) | `build-essential`, `make` — sandbox already has gcc 12.2.0, but the sysroot should carry it too (the reference one does) |
| `system-deps` 6.2.2 + 7.0.8 | `pkg-config` (via **G4**) |
| `librsvg2` (Tauri tray/icon) | `librsvg2-dev` |
| `enigo` 0.1 | `libxdo-dev`, `libx11-dev`, `libxtst-dev` |
| `libunwind` (per `install-desktop-linux-deps.sh`) | `libunwind-dev` |
| WebKitGTK media playback | `libgstreamer1.0-dev`, `libgstreamer-plugins-base1.0-dev`, `gstreamer1.0-plugins-base/-good/-bad` |
| WebKitGTK spellcheck | `libenchant-2-dev` |
| `sysinfo`, `libudev` | `libudev-dev` |
| `rust_gtk_pill` tests under `xvfb-run` | **`xvfb`, `xauth`** — *absent from the reference sysroot* |
| icon check gate `node scripts/generate-app-icons.mjs --check` | **`imagemagick`** (script resolves `magick` then `convert` on `PATH`, overridable) — *absent from the reference sysroot* |

Reference-sysroot packages that mausVoice does **not** need but which cost nothing to
keep: `bubblewrap`, `xdg-dbus-proxy`, `hunspell-en-us`, `emacs*`, `python3-mako`,
`libsv*`. Keep them; a smaller apt set risks dropping a transitive header.

---

## 4. Reference-branch anatomy (what "good" looks like, file by file)

Full measured tree of `better-Shape/app@vendor/sandbox-toolchain`. 3777 blobs,
881,839,972 bytes total. Reproduce this **shape**, with mausVoice's contents.

```
FETCH.md                                                   6,425 B
README.md                                                 15,155 B
MANIFEST.sha256                                          485,244 B   (3779 lines)

LICENSES/MPL-2.0.txt                                      16,726 B
LICENSES/debian/<package>/copyright                      470 files, 7.6 MB total
                                                            (exactly one file per package,
                                                             all named `copyright`)

rust/Cargo.lock.sha256                                        87 B   "<sha256>  src-tauri/Cargo.lock\n"
rust/cargo-config.toml                                       130 B   (source-replacement stanza)
rust/cargo-vendor.tar.xz.part-00                      94,371,840 B
rust/cargo-vendor.tar.xz.part-01                       4,947,172 B   -> 99 MB reassembled
rust/toolchain/rustc-1.89.0-x86_64-unknown-linux-gnu.tar.xz      81,862,808 B
rust/toolchain/rust-std-1.89.0-x86_64-unknown-linux-gnu.tar.xz   28,894,028 B
rust/toolchain/cargo-1.89.0-x86_64-unknown-linux-gnu.tar.xz      10,120,792 B
rust/toolchain/clippy-1.89.0-x86_64-unknown-linux-gnu.tar.xz      4,499,984 B
rust/toolchain/rustfmt-1.89.0-x86_64-unknown-linux-gnu.tar.xz     2,254,936 B
rust/toolchain/channel-rust-1.89.0.toml                             949,694 B

system/PKGS.txt                                             22,030 B   (496 lines)
system/debian12-dev-sysroot.tar.xz.part-00..02          94,371,840 B each
system/debian12-dev-sysroot.tar.xz.part-03              21,050,516 B   -> 304 MB reassembled
system/tools/TOOLS.txt                                       1,768 B
system/tools/bin/{cmake,file,patchelf,pkgconf}          5 files (pkg-config -> pkgconf symlink)
system/tools/lib/*.so*                                    42 files, ~48 MB (libicudata.so.72 = 31 MB)
system/tools/share/cmake-3.25/**                        3,144 blobs (Help/, Modules/, Templates/, include/)
system/tools/share/magic.mgc                                 1 file

chrome-deps/npm-chromium-153/*.so{,.N}                     9 files, 3.65 MB
chrome-deps/cft-156/PACKAGES.txt                           3,215 B
chrome-deps/cft-156/*.so*                                 81 files, 30 MB

browsers/BROWSERS.txt                                      1,617 B
browsers/browsers-playwright-1.64.1.tar.xz.part-00..01  94,371,840 B each
browsers/browsers-playwright-1.64.1.tar.xz.part-02      38,634,324 B   -> 227 MB reassembled
```

Manifest arithmetic (verify yours the same way): `3779 lines = 3762 whole files +
9 part files + 8 reassembled-archive entries`. The 8 reassembled entries are the three
split archives **plus** the five unsplit `rust/toolchain/*.tar.xz` files, which appear
once. `MANIFEST.sha256` cannot list itself, which is why 3777 blobs → 3762 whole-file
entries.

Two documentation files whose **prose style and section structure you should mirror**
(the consumer is an agent; the value is in the "things that will bite you" sections):

`README.md` sections — *Vendored sandbox toolchain* → *Who this is for* → *What is
here* (table: directory / what it holds / packed size / on-disk size) → *How to consume
it* → *Verification performed before this branch was pushed* (table of check / command /
result) → *Things the consumer must know* (prose, each item a named trap) → *Provenance*
(per-artifact: upstream URL, upstream hash, exact command) → *Licences* → *Size notes*.

`FETCH.md` sections — numbered 1..8: *Download the branch* (two options: `codeload`
tarball, depth-1 single-branch clone) → *Reassemble the split archives and verify* →
*Wire up the Rust toolchain* → *Wire up the cargo vendor tree, offline* → *Wire up the
sysroot* → *Command line tools* → *Browsers and the library closure* → *Build, lint and
test* → *Sanity checks* → *Cautions*.

Two **defects in the reference branch to not copy**:

1. `rust/cargo-config.toml` on disk says `directory = "/workspace/vendor-work/cargo-vendor"`,
   but `FETCH.md` tells the consumer to write `directory = "/tmp/cargo-vendor"`. The
   checked-in file is stale and unusable as-is. Either make yours correct, or say in
   `README.md` that it is a template whose `directory` must be rewritten.
2. The reference `README.md` states the clippy invocation from *its* spec was wrong
   (`cargo --offline --config <path> clippy` fails because cargo does not forward
   `--config`/`--offline` to **external** subcommands like `clippy` and `nextest`; only
   built-ins like `check`, `metadata`, `tree` honour them). That finding is **still
   true and still applies to mausVoice** — put it in your `README.md` verbatim in
   substance, and use `$CARGO_HOME/config.toml` + `CARGO_NET_OFFLINE=true`, never
   `cargo --config`.

---

## 5. Size budget (plan for it before you start)

| Group | Reference (packed) | mausVoice estimate (packed) | Why it moves |
| --- | --- | --- | --- |
| G1 Rust toolchain | 123 MB (1.33 GB on disk) | ~123 MB | Same five components, 1.88.0 instead of 1.89.0 |
| G2 cargo vendor | 99 MB / 759 crates (344 MB on disk) | **~170–230 MB / 1124 packages** | 1.48× the packages; `windows` 0.58 **and** 0.61.3 metadata, `wgpu`, `sqlx`, `ort`, `whisper-rs-sys` (bundles whisper.cpp C++ source), two `bindgen` |
| G3 sysroot | 304 MB / 496 pkgs (1.30 GB on disk) | **~450–600 MB / ~600–700 pkgs** | adds `clang`+`libclang-dev`+`libllvm*` (~250 MB on disk), `libpulse-dev`, `libasound2-dev`, `libgtk-layer-shell-dev`, `libxdo-dev`, `xvfb`+`xauth`, `imagemagick` |
| G4 CLI tools | 86 MB | ~86 MB | Same four tools + closure |
| G5 native build payloads | — (group does not exist) | **~45 MB** (ORT `.tgz` ~15 MB + sherpa static `.tar.bz2` ~22 MB, both already compressed) | **New group, mausVoice-only** |
| G6 browser/driver | 227 MB + 34 MB | **0 B** by default | **Dropped** — see §12 D-2 |
| G7 licences | 7.6 MB | ~9 MB | More packages → more `copyright` files |
| G8 manifest+docs | 0.5 MB | ~0.6 MB | More files → more lines |
| **Total** | **880 MB** | **~0.9–1.1 GB** | |

Extracted total ≈ **3.5–4.5 GB** in `/tmp`. Against 19 GB free that leaves room for
`target/` dirs, but `README.md` must still tell the consumer to delete the downloaded
tarball/clone after extraction and to reuse one `CARGO_TARGET_DIR`.

---

## 6. Group-by-group build specifications

Build everything inside a **clean `debian:12` container** (bookworm, amd64) so versions
match the consumer exactly. Do not build on Ubuntu and do not build on the host.

### G1 — Rust 1.88.0 components

**Layout**

```
rust/toolchain/rustc-1.88.0-x86_64-unknown-linux-gnu.tar.xz
rust/toolchain/rust-std-1.88.0-x86_64-unknown-linux-gnu.tar.xz
rust/toolchain/cargo-1.88.0-x86_64-unknown-linux-gnu.tar.xz
rust/toolchain/rustfmt-1.88.0-x86_64-unknown-linux-gnu.tar.xz
rust/toolchain/clippy-1.88.0-x86_64-unknown-linux-gnu.tar.xz
rust/toolchain/channel-rust-1.88.0.toml
```

**Source.** `https://static.rust-lang.org/dist/<component>-1.88.0-x86_64-unknown-linux-gnu.tar.xz`
and `https://static.rust-lang.org/dist/channel-rust-1.88.0.toml`.

**Recipe**

```bash
V=1.88.0; T=x86_64-unknown-linux-gnu
mkdir -p out/rust/toolchain
for c in rustc rust-std cargo rustfmt clippy; do
  curl -fSL --retry 3 -o "out/rust/toolchain/$c-$V-$T.tar.xz" \
    "https://static.rust-lang.org/dist/$c-$V-$T.tar.xz"
done
curl -fSL --retry 3 -o "out/rust/toolchain/channel-rust-$V.toml" \
  "https://static.rust-lang.org/dist/channel-rust-$V.toml"
```

**Provenance you must record in `README.md`.** `channel-rust-1.88.0.toml` publishes an
`xz_hash` per component. Verify each downloaded file against it and print the table,
exactly as the reference README does:

```bash
python3 - <<'PY'
import tomllib, hashlib, pathlib
d = tomllib.load(open("out/rust/toolchain/channel-rust-1.88.0.toml","rb"))
for pkg in ("rustc","rust-std","cargo","rustfmt","clippy"):
    want = d["pkg"][pkg]["target"]["x86_64-unknown-linux-gnu"]["available"]
    xz   = d["pkg"][pkg]["target"]["x86_64-unknown-linux-gnu"]["xz_hash"]
    p = pathlib.Path(f"out/rust/toolchain/{pkg}-1.88.0-x86_64-unknown-linux-gnu.tar.xz")
    got = hashlib.sha256(p.read_bytes()).hexdigest()
    print(f"{pkg:10s} available={want} {'MATCH' if got==xz else 'MISMATCH'}")
    print(f"           upstream xz_hash {xz}")
    print(f"           measured sha256  {got}")
PY
```

**Verification.** Each tarball contains `<component>-1.88.0-x86_64-unknown-linux-gnu/install.sh`.
Install into a scratch prefix and confirm:

```bash
P=$(mktemp -d); for t in out/rust/toolchain/*-1.88.0-*.tar.xz; do
  d=$(mktemp -d); tar xJf "$t" -C "$d"; "$d"/*/install.sh --prefix="$P" --disable-ldconfig; rm -rf "$d"
done
PATH="$P/bin:$PATH" LD_LIBRARY_PATH="$P/lib" bash -c 'rustc --version; cargo --version; cargo clippy --version; cargo fmt --version'
# expect: rustc 1.88.0 / cargo 1.88.0 / clippy 0.1.88 / rustfmt 1.8.0-stable
```

`--disable-ldconfig` matters: the consumer has no root and no writable
`/etc/ld.so.conf.d`. `LD_LIBRARY_PATH="$PREFIX/lib"` is required at run time — the
reference `FETCH.md` sets it and so must yours.

Note `rustc-1.88.0-…tar.xz` is ~82 MB, under the cap; **no component needs splitting**.
Verify with `stat -c %s` anyway.

### G2 — Cargo vendor tree (the union of seven workspaces)

**Layout**

```
rust/cargo-vendor.tar.xz            (split into .part-NN if >= 90 MiB — it will be)
rust/cargo-config.toml              (the full source-replacement stanza cargo prints)
rust/Cargo.lock.sha256              (all seven lockfiles, one line each)
```

#### 6.2.1 One vendor tree, seven manifests

`cargo vendor` supports extra manifests via `--sync`. Use **one** invocation so the
union is deduplicated and the printed config covers every source:

```bash
cd /path/to/mausVoice          # a full checkout at the reference commit
cargo vendor --locked --versioned-dirs \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --sync apps/windows-installer/src-tauri/Cargo.toml \
  --sync packages/rust_transcription/Cargo.toml \
  --sync packages/rust_gtk_pill/Cargo.toml \
  --sync packages/rust_macos_pill/Cargo.toml \
  --sync packages/rust_windows_pill/Cargo.toml \
  --sync packages/rust_pill_shared/Cargo.toml \
  /tmp/cargo-vendor > /tmp/cargo-config-printed.toml
```

Notes:

- `--versioned-dirs` gives `name-version/` directories, which is what keeps two
  versions of the same crate (`bindgen` 0.71.1 *and* 0.72.1; `cc` 1.2.59 *and* 1.4.3;
  `windows-sys` 0.45/0.48/0.52/0.59/0.60.2/0.61.2; `js-sys`, `wasm-bindgen`,
  `clang-sys`, `system-deps`, `dirs-sys`, `jni-sys` …) from colliding. **Mandatory here**,
  not optional as it effectively was for the reference branch.
- `--locked` refuses to touch the committed lockfiles. If it wants to change one, stop
  and say so in `README.md` — that means the branch is being built against a dirty tree.
- Redirect stdout: that **is** `rust/cargo-config.toml`.
- If `--sync` with seven manifests errors, fall back to seven separate
  `cargo vendor --locked --versioned-dirs --manifest-path <m> /tmp/cargo-vendor-<n>`
  runs merged with `rsync -a --ignore-existing`, then hand-write the config stanza.
  Record which path you took.

#### 6.2.2 The git dependency

`ferrous-focus 0.4.1` from
`git+https://github.com/MichaelWGibson/ferrous-focus#3816f6a1214240b801c32e05c1abdff3b784b15f`.
`cargo vendor` **does** vendor git sources, and it emits an extra stanza. Expect
`rust/cargo-config.toml` to look like this (the reference branch's had only the first
and last blocks):

```toml
[source.crates-io]
replace-with = "vendored-sources"

[source."git+https://github.com/MichaelWGibson/ferrous-focus#3816f6a1214240b801c32e05c1abdff3b784b15f"]
git = "https://github.com/MichaelWGibson/ferrous-focus"
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "/tmp/cargo-vendor"
```

Ship the config **with the `directory` already pointing at the documented extraction
path** (`/tmp/cargo-vendor`), or ship it as a template and say so — but do not repeat
the reference branch's mismatch (§4, defect 1). Verify the git crate landed:

```bash
ls -d /tmp/cargo-vendor/ferrous-focus-* && cat /tmp/cargo-vendor/ferrous-focus-*/.cargo-checksum.json | head -c 200
```

#### 6.2.3 The `[patch.crates-io]` path patches

`block = { path = "…/patches/block-0.1.6" }` and
`sherpa-onnx-sys = { path = "…/patches/sherpa-onnx-sys-1.13.5" }` are **in-repo path
patches**. They must **not** appear in the vendor tree; they resolve from the checkout.
Confirm:

```bash
ls -d /tmp/cargo-vendor/block-0.1.6 /tmp/cargo-vendor/sherpa-onnx-sys-1.13.5 2>&1   # want: No such file
ls -d /tmp/cargo-vendor/rdev-* 2>&1                                                  # want: No such file
```

If `cargo vendor` instead errors with *found duplicate versions of package `block`* (or
`sherpa-onnx-sys`), the documented workarounds, in order of preference:

1. Re-run without `--locked` into a scratch dir **only to discover the tree**, then
   restore the lockfiles from git (`git checkout -- '**/Cargo.lock'`) and re-run with
   `--locked`. Record what you did.
2. Temporarily comment out the `[patch.crates-io]` block, vendor, restore it. Then the
   vendor tree will contain the *unpatched* `block 0.1.6` / `sherpa-onnx-sys 1.13.5`
   from crates.io. That is acceptable **only** because the patch stanza in each
   `Cargo.toml` wins at resolve time; but verify offline resolution afterwards, and if
   cargo picks the vendored copy instead of the path patch, the build will use
   upstream's `sherpa-onnx-sys` and silently lose the digest pinning. **Test gate G-2
   catches this** — do not skip it.

#### 6.2.4 `rust/Cargo.lock.sha256`

The reference file is one line, `<sha256>  src-tauri/Cargo.lock`. Here there are seven.
Write all seven, paths relative to the repo root, sorted:

```bash
sha256sum \
  apps/desktop/src-tauri/Cargo.lock \
  apps/windows-installer/src-tauri/Cargo.lock \
  packages/rust_gtk_pill/Cargo.lock \
  packages/rust_macos_pill/Cargo.lock \
  packages/rust_pill_shared/Cargo.lock \
  packages/rust_transcription/Cargo.lock \
  packages/rust_windows_pill/Cargo.lock \
  > out/rust/Cargo.lock.sha256
```

Expected content (measured 2026-10-28 at `249e465b9eca27b70c4c74da79ff9fb88517d1d5`):

```
b97457241ba33dbc2801592bbb885fc324c8c7a3fa8a35016585dfcef3596d09  apps/desktop/src-tauri/Cargo.lock
52c46c5acf9a010074ec7aa35f2a25e9fc8b4313a599ec58608c81d1195eb54d  apps/windows-installer/src-tauri/Cargo.lock
a77ee040b276204ea904d60c643eb6df876c0a8edbe293f5da1a545adfccc502  packages/rust_gtk_pill/Cargo.lock
d52f9ad2aa16e9f950293c0a8789eca9106a84eb0bf24dae1237193a472e8c4e  packages/rust_macos_pill/Cargo.lock
fe6f4c1c7b138939c221ebe28762d0144fe80b2f0a63f4adecde29bff2a535cd  packages/rust_pill_shared/Cargo.lock
3611a2fc2201f408527bb19f2d1f9487a6bd25dcf824693848151cecaa94731b  packages/rust_transcription/Cargo.lock
ac064090df74395b85deb1aee7e2b59a4608c64333232b874116530c35626a0f  packages/rust_windows_pill/Cargo.lock
```

The consumer runs `sha256sum -c rust/Cargo.lock.sha256` from the repo root and **refuses
to build** on any mismatch — a vendor tree built against different lockfiles resolves
offline to the wrong versions and fails confusingly.

#### 6.2.5 Pack

```bash
tar -C /tmp/cargo-vendor -cJf out/rust/cargo-vendor.tar.xz .
```

Consider `XZ_OPT=-9e` only if you have the RAM; on a 3.9 GB-class builder `-9e` can
OOM. `-6` (default) is fine and is almost certainly what the reference used.
**Never `zstd`** — the consumer has no `zstd` binary (§2.3).

Record in `README.md`: crate/package count, on-disk size after extraction
(`du -sb /tmp/cargo-vendor`), file count, and "registry + 1 git source, 2 in-repo path
patches, no other patches".

### G3 — Debian 12 development sysroot

**Layout**

```
system/debian12-dev-sysroot.tar.xz    (split; will be 4-7 parts)
system/PKGS.txt                       (Package + Version for every .deb folded in)
```

#### 6.3.1 The apt set

Union of `.github/scripts/install-desktop-linux-deps.sh`, `.github/workflows/lint-desktop.yml`,
`.github/workflows/release.yml`, `.github/workflows/test-package-rust-transcription.yml`,
`.github/workflows/test-desktop-unit.yml`, `docs/Installing-cargo-toolchain-for-kilocode-bot-agents-in-a-linux-sandbox.md`,
the reference branch's list, and the crate→package map in §3.4:

```bash
rm -f /etc/apt/apt.conf.d/docker-clean      # <-- see trap 1 below
apt-get update
apt-get install -y --no-install-recommends \
  build-essential pkg-config pkgconf cmake patchelf file curl wget git \
  clang libclang-dev llvm \
  libgtk-3-dev libglib2.0-dev libcairo2-dev libpango1.0-dev \
  libgdk-pixbuf-2.0-dev libharfbuzz-dev libatk1.0-dev libatk-bridge2.0-0 \
  libatspi2.0-dev libepoxy-dev libgl-dev libgles-dev libegl-dev libopengl-dev \
  libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
  libayatana-appindicator3-dev librsvg2-dev libgtk-layer-shell-dev \
  libasound2-dev libpulse-dev libunwind-dev libxdo-dev libudev-dev \
  libssl-dev libdbus-1-dev libffi-dev uuid-dev zlib1g-dev libzstd-dev \
  liblzma-dev libbz2-dev \
  libx11-dev libxext-dev libxrandr-dev libxi-dev libxcursor-dev libxinerama-dev \
  libxtst-dev libxcb1-dev libxcb-render0-dev libxcb-shm0-dev libxkbcommon-dev \
  libwayland-dev libwayland-bin wayland-protocols \
  libenchant-2-dev \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  xvfb xauth imagemagick \
  python3 python3-distutils
```

Optional, only if §12 D-5 says the consumer must be able to *bundle*:
`libfuse2 rpm wtype appimage` tooling. `install-desktop-linux-deps.sh` installs
`libfuse2`, `wtype` and `rpm`; `build-desktop.yml` sets `APPIMAGE_EXTRACT_AND_RUN=1`.
None of the unit/lint/fmt gates need them.

**Do not** substitute `libwebkit2gtk-4.0-dev`. Debian 12 has 4.1; the repo's
`apt-cache show` probe is for other distros.

#### 6.3.2 Trap 1 — `docker-clean`

`debian:12` ships `/etc/apt/apt.conf.d/docker-clean`, which runs `apt-get clean` after
every install. The reference branch documents that this silently produced an incomplete
tree on its first build. Remove it **before** `apt-get install`, or use
`-o DPkg::Post-Invoke::=` . Then extract from `/var/cache/apt/archives/*.deb`.

#### 6.3.3 Trap 2 — usr-merge (the one that actually breaks the link)

The reference README documents this at length and it applies identically here:

> Debian 12 is usr-merged: `/lib`, `/bin`, `/sbin` are symlinks into `/usr`, but
> `dpkg-deb -x` creates **real directories** at those paths. Runtime SONAMEs such as
> `libexpat.so.1` therefore land under `lib/`, off the linker search path the recipe
> sets, and linking the Tauri stack fails with `undefined reference to XML_Parse`.

Their fixer (`fix-sysroot-links.py`, not shipped — you must write it) does five things:

1. Fold `lib`, `lib64`, `bin`, `sbin` into `usr`, replacing each with the symlink the
   base image ships.
2. Rewrite **every absolute symlink** to a relative one.
3. Rewrite **every library symlink whose target is absent** to a relative link.
4. **Copy the real file in** when the target lives outside the extracted tree.
5. **Delete the static archives** `libdbus-1.a`, `libffi.a`, `libuuid.a`,
   `libpcre2-8.a`, `libzstd.a`, `libmount.a`, `libblkid.a`, `libudev.a`,
   `libselinux.a`.

On (5), their words: *"Those static archives are the trap that turns a symlink problem
into a link error, and nothing in this build links them statically."* Add any further
`.a` you find that shadows a `.so` the consumer will link — but be careful with
`libsqlite3-sys`/`onig_sys`/`bzip2-sys`, which **compile their own** bundled C and need
no system `.a`.

Skeleton:

```bash
mkdir -p /tmp/gtk-sysroot
for d in /var/cache/apt/archives/*.deb; do dpkg-deb -x "$d" /tmp/gtk-sysroot; done
python3 fix-sysroot-links.py /tmp/gtk-sysroot
tar -C /tmp/gtk-sysroot -cJf out/system/debian12-dev-sysroot.tar.xz .
```

#### 6.3.4 `system/PKGS.txt`

One line per package, `Package: <name>\tVersion: <version>` (that is the reference
format — tab-separated on a single line, 496 lines there). Generate from the `.deb`s:

```bash
for d in /var/cache/apt/archives/*.deb; do
  dpkg-deb -f "$d" Package Version | tr '\n' '\t' | sed 's/\t$//'; echo
done | sort > out/system/PKGS.txt
```

Expect ~600–700 lines. Record the count in `README.md`.

#### 6.3.5 Verification (all of these are reference-branch checks; run them all)

```bash
# 1. pkg-config resolves the mausVoice stack. These are the modules the crates query.
export PKG_CONFIG_SYSROOT_DIR=/tmp/gtk-sysroot
export PKG_CONFIG_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/tmp/gtk-sysroot/usr/share/pkgconfig
export PKG_CONFIG=/tmp/gtk-sysroot/usr/bin/pkg-config
for m in gtk+-3.0 gdk-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 openssl \
         glib-2.0 gio-2.0 gobject-2.0 cairo pango pangocairo gdk-pixbuf-2.0 atk \
         atk-bridge-2.0 librsvg-2.0 ayatana-appindicator3-0.1 gtk-layer-shell-0 \
         alsa libpulse libpulse-simple gstreamer-1.0 gstreamer-plugins-base-1.0 \
         enchant-2 libudev x11 xext xrandr xi xcursor xcb xkbcommon wayland-client \
         harfbuzz liblzma zlib libzstd; do
  printf '%-30s %s\n' "$m" "$("$PKG_CONFIG" --modversion "$m" 2>&1)"
done
# Every line must print a version. `gtk-layer-shell-0`, `alsa`, `libpulse-simple` and
# `ayatana-appindicator3-0.1` are the four the reference sysroot would have failed.

# 2. No dangling library symlink, no absolute symlink.
find /tmp/gtk-sysroot -xtype l | grep -E '\.so' || echo "no broken library symlinks"
find /tmp/gtk-sysroot -type l -lname '/*'      | head   # must be empty

# 3. libclang is present and discoverable by clang-sys.
ls /tmp/gtk-sysroot/usr/lib/llvm-*/lib/libclang.so* /tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu/libclang*.so* 2>/dev/null
# Record the exact path: the consumer will need LIBCLANG_PATH if it is not on the
# default search path (see §9 step 5).

# 4. Xvfb runs.
LD_LIBRARY_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu \
  /tmp/gtk-sysroot/usr/bin/Xvfb :99 -screen 0 1280x800x24 & sleep 2; kill %1

# 5. Architecture. Every ELF must be 64-bit x86-64.
find /tmp/gtk-sysroot -type f -exec sh -c 'readelf -h "$1" 2>/dev/null | grep -q "ELF 64-bit" && readelf -h "$1" | grep -q X86-64 || echo "BAD $1"' _ {} \; | head

# 6. Link the libraries that a symlink bug would break.
printf 'int main(){return 0;}\n' > /tmp/t.c
gcc /tmp/t.c -o /tmp/t.out -L/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu \
  -ldbus-1 -lffi -luuid -lpcre2-8 -lzstd -lmount -lblkid -ludev \
  -lasound -lpulse -lpulse-simple -lxdo -lgtk-3 -lgdk-3 -lwebkit2gtk-4.1 \
  -ljavascriptcoregtk-4.1 -lsoup-3.0 -lgtk-layer-shell && echo "link ok"

# 7. Archive integrity + entry count (reference recorded 44511 entries for its 304 MB).
tar tJf out/system/debian12-dev-sysroot.tar.xz | wc -l
```

### G4 — Command-line tools tree

**Layout** (identical to the reference)

```
system/tools/TOOLS.txt          <filename>\t<package>\t<version>   (reference: 48 lines)
system/tools/bin/cmake
system/tools/bin/file
system/tools/bin/patchelf
system/tools/bin/pkgconf
system/tools/bin/pkg-config     -> symlink to pkgconf in the SAME directory
system/tools/lib/*.so*          (reference: 42 files; libicudata.so.72 alone is 31 MB)
system/tools/share/cmake-3.25/**  (Help/, Modules/, Templates/, include/cmCPluginAPI.h)
system/tools/share/magic.mgc
```

**Recipe.** In a clean `debian:12` container, install `pkg-config cmake patchelf file`
plus their runtime closure, copy the binaries and every library `ldd` reports, then
rpath each binary so the tree runs with **no `LD_LIBRARY_PATH`**:

```bash
apt-get install -y --no-install-recommends pkg-config cmake patchelf file
mkdir -p /tmp/tools/{bin,lib,share}
for b in cmake file patchelf pkgconf; do cp -a "$(command -v $b)" /tmp/tools/bin/; done
ln -sf pkgconf /tmp/tools/bin/pkg-config
for b in /tmp/tools/bin/*; do
  [ -L "$b" ] && continue
  ldd "$b" | awk '/=> \//{print $3}' | while read -r l; do cp -an "$l" /tmp/tools/lib/; done
  patchelf --set-rpath '$ORIGIN/../lib' "$b"
done
cp -a /usr/share/cmake-3.25 /tmp/tools/share/
cp -a /usr/share/misc/magic.mgc /tmp/tools/share/
```

Debian 12 versions the reference recorded (yours should match, but **record what you
actually measure**): `pkg-config`/`pkgconf` **1.8.1**, `cmake` **3.25.1**,
`patchelf` **0.14.3**, `file`/`libmagic1` **1:5.44-3**.

Also copy the closure libraries the reference lists — note in particular
`libarchive.so.13`, `libjsoncpp.so.25`, `librhash.so.0`, `libuv.so.1`, `libcurl.so.4`,
`libssl.so.3`/`libcrypto.so.3`, `libicudata.so.72`/`libicuuc.so.72`, `libpkgconf.so.3`,
`libmagic.so.1`, `libxml2.so.2`, `libssh2.so.1`, `libnghttp2.so.14`, `libpsl.so.5`,
`librtmp.so.1`, `libsasl2.so.2`, `libldap`/`liblber`, `libgnutls.so.30`,
`libnettle`/`libhogweed`, `libgmp`, `libp11-kit`, `libtasn1`, `libidn2`,
`libunistring`, `libkrb5`/`libgssapi_krb5`/`libk5crypto`/`libkrb5support`/`libkeyutils`/`libcom_err`,
`liblz4`, `liblzma`, `libz`, `libzstd`, `libbz2`, `libbrotli*`, `libffi`, `libacl`, `libmd`.

`TOOLS.txt` generation:

```bash
for f in /tmp/tools/bin/* /tmp/tools/lib/*; do
  n=$(basename "$f"); p=$(dpkg -S "$(readlink -f "$f")" 2>/dev/null | cut -d: -f1)
  v=$(dpkg-query -W -f='${Version}' "$p" 2>/dev/null)
  printf '%s\t%s\t%s\n' "$n" "${p:-apt}" "${v:-unknown}"
done | sort -u > out/system/tools/TOOLS.txt
```

**Verification.** In a container with **none** of these packages installed:

```bash
export PATH=/tmp/tools/bin:$PATH
pkg-config --version   # 1.8.1
cmake --version        # 3.25.1
patchelf --version     # 0.14.3
file --version
ldd /tmp/tools/bin/cmake | grep "not found" || echo "closure complete"
env -i /tmp/tools/bin/cmake --version    # runs with an empty environment => rpath works
```

**Reference caution to carry over verbatim:** *"`system/tools/bin/pkg-config` is a
symlink to `pkgconf` in the same directory. Copy the whole `system/tools/` tree, not
individual files."*

### G5 — Native build-time payloads (NEW; mausVoice-only, mandatory)

This group has no counterpart in the reference branch and is the reason a straight copy
would fail. Two `build.rs` scripts download from **GitHub Releases**, i.e. from
`objects.githubusercontent.com` after a redirect — unreachable (§2.2).

#### 6.5.1 ONNX Runtime 1.23.2 — `packages/rust_transcription/build.rs`

```rust
const ORT_VERSION: &str = "1.23.2";
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
// url = format!("https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{}", archive_name)
```

Per-target archive names and pinned sha256, copied from `runtime_asset()`:

| Target | Archive | sha256 | Kind |
| --- | --- | --- | --- |
| `x86_64-unknown-linux-gnu` | `onnxruntime-linux-x64-1.23.2.tgz` | `1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b` | tar.gz |
| `aarch64-unknown-linux-gnu` | `onnxruntime-linux-aarch64-1.23.2.tgz` | `7c63c73560ed76b1fac6cff8204ffe34fe180e70d6582b5332ec094810241e5c` | tar.gz |
| `x86_64-apple-darwin`, `aarch64-apple-darwin` | `onnxruntime-osx-universal2-1.23.2.tgz` | `49ae8e3a66ccb18d98ad3fe7f5906b6d7887df8a5edd40f49eb2b14e20885809` | tar.gz |
| `x86_64-pc-windows-msvc` | `onnxruntime-win-x64-1.23.2.zip` | `0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd` | zip |
| `aarch64-pc-windows-msvc` | `onnxruntime-win-arm64-1.23.2.zip` | `1cfe88b6435df3b5fb0e9f6bd7d6f5df1e887b6174de7f6e2a47bab956f3f168` | zip |

**Ship only `onnxruntime-linux-x64-1.23.2.tgz`.** The consumer is x86_64 Linux; the
other four are dead weight (~1 GB). State in `README.md` that the other targets are
pinned in `build.rs` and were deliberately not vendored.

Download: `https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-linux-x64-1.23.2.tgz`

**Two consumer escape hatches, both of which `FETCH.md` must document:**

1. Env override (simplest, and what `FETCH.md` should use):
   `MAUSVOICE_ORT_DYLIB_PATH` or `ORT_DYLIB_PATH` pointing at an extracted
   **`libonnxruntime.so` file**. `configured_runtime()` takes the first of the two that
   `path.is_file()`. `build.rs` then copies it beside the built binaries and into
   `deps/`, and emits `cargo:rustc-env=MAUSVOICE_BUILD_ORT_DYLIB=<path>`.
   The library file name is `libonnxruntime.so` on Linux (`runtime_library_name()`).
2. Cache pre-seed: place the `.tgz` at
   `<CARGO_TARGET_DIR>/mausvoice-onnxruntime/1.23.2/onnxruntime-linux-x64-1.23.2/onnxruntime-linux-x64-1.23.2.tgz`.
   `build.rs` verifies the digest and extracts. Fragile (depends on `CARGO_TARGET_DIR`
   and the archive-stem directory name) — prefer (1).

**Layout for the branch:**

```
native/onnxruntime/onnxruntime-linux-x64-1.23.2.tgz        (~15 MB, no split)
native/onnxruntime/ORRUNTIME.txt                            provenance: URL, sha256, upstream release tag
```

(If you prefer to ship the already-extracted `libonnxruntime.so` instead of the `.tgz`,
say so in `README.md` and give its sha256 — but shipping the upstream archive keeps the
`build.rs` digest check meaningful.)

#### 6.5.2 sherpa-onnx v1.13.5 — `patches/sherpa-onnx-sys-1.13.5/build.rs`

```rust
const RELEASE_BASE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
// url = format!("{RELEASE_BASE_URL}/v{version}/{archive_name}")   version = CARGO_PKG_VERSION = 1.13.5
```

Full pinned digest table (`ARCHIVE_SHA256_DIGESTS`) — **ship only the linux-x64 static
one**, but reproduce the whole table in `README.md` provenance so a future maintainer
can extend the branch:

| Archive | sha256 |
| --- | --- |
| **`sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2`** | **`2ade8b7c62de66b9cf2e32bd7dbe077addaa4b18f422b49dc1bf3a1a0b1f762e`** |
| `sherpa-onnx-v1.13.5-linux-aarch64-static-lib.tar.bz2` | `f78af8260892f3060c8c0aba9ae93e4e4c1b16fe509238b88e3688889235e1b2` |
| `sherpa-onnx-v1.13.5-osx-x64-static-lib.tar.bz2` | `689f8167a52dc4dbaf05369705e26c8f203c748a8c342750fdfdcd8ca6bb8699` |
| `sherpa-onnx-v1.13.5-osx-arm64-static-lib.tar.bz2` | `339c8fc19bb4b26e118c80792bbc4546eb263040fac36ef0cc027ec29c756b44` |
| `sherpa-onnx-v1.13.5-osx-universal2-static-lib.tar.bz2` | `9e64f3274c4209c485fdb936c22bee27f4940e1872f3e93abe0e3e6db0190148` |
| `sherpa-onnx-v1.13.5-win-x64-static-MT-Release-lib.tar.bz2` | `b7080b6f470bac96ef0afe56b25ae9b2f9f0ca82d10dad19bf3a2fc5ffd6cffc` |
| `sherpa-onnx-v1.13.5-linux-x64-shared-lib.tar.bz2` | `dee76d27657cab8cb95a47322e88d93977d9a7e75f0a1abad032d8843e1542c9` |
| `sherpa-onnx-v1.13.5-linux-aarch64-shared-cpu-lib.tar.bz2` | `e9e284e887c67959f45b2cad834d9b2fae281bb4e8e596928ffe371506d803ac` |
| `sherpa-onnx-v1.13.5-osx-x64-shared-lib.tar.bz2` | `e1868ca5b756b0d5d33682b187cbce6cd448edf785e3fa8b7586f2c04cb0d84c` |
| `sherpa-onnx-v1.13.5-osx-arm64-shared-lib.tar.bz2` | `df54b4f9406e00c3aee9152aeca65795848d197b80917ecb0bd472b852c5db9f` |
| `sherpa-onnx-v1.13.5-osx-universal2-shared-lib.tar.bz2` | `79b1635418e1ec0ec2f72f7a2bda1467914cbb9a9e411b5b4800d97fc1110598` |
| `sherpa-onnx-v1.13.5-win-x64-shared-MT-Release-lib.tar.bz2` | `e7092add4a05013043b5c7f0fa4ccd3de9cf2840a51b6501caf20c03086d2b97` |
| `sherpa-onnx-v1.13.5-android.tar.bz2` | `635eee004bf12d5881789876ea01964a6ef10dc74ccf317271ba9388d8718a84` |

`archive_name()` selects `sherpa-onnx-v{version}-linux-x64-static-lib.tar.bz2` for
`(LinkMode::Static, "linux", "x86_64")`, which is what
`packages/rust_transcription/Cargo.toml` requests on non-Windows/non-Android
(`features = ["static"]`).

Download: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.5/sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2`
(~22 MB — no split needed).

**Consumer escape hatches, in the order `build.rs` evaluates them:**

1. `DOCS_RS=1` → skips downloading *and* linking. Do **not** use: it changes what gets
   linked and the resulting binary is not the one CI tests.
2. **`SHERPA_ONNX_LIB_DIR=<dir>`** → used directly as the lib dir; bypasses the archive
   and the digest check entirely. `build.rs` errors if the dir does not exist.
3. **`SHERPA_ONNX_ARCHIVE_DIR=<dir>`** → `build.rs` copies
   `<dir>/sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2` into its cache and verifies
   the pinned digest. **This is the one to document** — it keeps the digest check live.
   It errors with `SHERPA_ONNX_ARCHIVE_DIR does not contain expected archive: <path>`
   if the file name is not exactly right.

Cache layout `build.rs` maintains (useful for pre-seeding instead, and worth documenting
so the consumer can debug):

```
<CARGO_TARGET_DIR or .../target>/sherpa-onnx-prebuilt/
    sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2
    sherpa-onnx-v1.13.5-linux-x64-static-lib/lib/          <- what gets linked
    sherpa-onnx-v1.13.5-linux-x64-static-lib.extracted.sha256
```

Note the extracted-tree digest: `build.rs` re-verifies the extracted tree against a
recorded digest and re-extracts from the verified archive if it does not match. If the
consumer pre-seeds the *extracted* directory without the archive, `build.rs` discards it
as unverifiable ("the archive it came from is missing") and tries to download. **Pre-seed
the archive, or use `SHERPA_ONNX_ARCHIVE_DIR`.**

Static libs it links (`SHERPA_ONNX_STATIC_LIBS`) — record in `README.md` so a consumer
debugging an undefined symbol knows what to look for:
`sherpa-onnx-c-api`, `sherpa-onnx-core`, `kaldi-decoder-core`,
`sherpa-onnx-kaldifst-core`, `sherpa-onnx-fstfar`,
`sherpa-onnx-fst`, `kaldi-native-fbank-core`, `kissfft-float`, `piper_phonemize`,
`espeak-ng`, `ucd`, `onnxruntime`, `ssentencepiece_core`.
Its build-deps are `bzip2 0.4`, `tar 0.4`, `ureq 2.12` (`proxy-from-env`), `sha2 0.10` —
all vendored by G2.

**Layout for the branch:**

```
native/sherpa-onnx/sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2
native/sherpa-onnx/SHERPA.txt     provenance: URL, sha256, the full digest table, link-mode rationale
```

**Cross-check:** `scripts/ci/verify-sherpa-archives.test.mjs` asserts that
`patches/sherpa-onnx-sys-1.13.5/build.rs` pins exactly these archives —
`linux-x64-static`, `linux-aarch64-static`, `osx-x64-static`, `osx-arm64-static`,
`win-x64-static-MT-Release`, `win-x64-shared-MT-Release`. Run
`node --test scripts/ci/verify-sherpa-archives.test.mjs` after your build; if it fails,
the repo moved and your digests are stale.

#### 6.5.3 What you must NOT try to vendor

- **Model weights.** `packages/rust_transcription/src/models.rs` pins Hugging Face URLs
  (`huggingface.co/csukuangfj/sherpa-onnx-sense-voice-…`,
  `onnx-community/parakeet-ctc-0.6b-ONNX`, `istupakov/parakeet-tdt-0.6b-v3-onnx`,
  `istupakov/canary-1b-v2-onnx`, plus `ggerganov/whisper.cpp` GGML files). Sizes run
  77 MB (`ggml-tiny.bin`) to 3.1 GB (`ggml-large-v3.bin`); SenseVoice is ~226 MB.
  `huggingface.co` is unreachable, so the **`--ignored` end-to-end tests in
  `tests/sidecar_integration.rs` cannot run in the sandbox.** That is expected and
  matches CI's own note that those tests download model artifacts. Record the exclusion
  in `README.md` under "Things the consumer must know" — an agent that does not know
  will burn an hour on it. Whisper URLs are overridable with
  `RUST_TRANSCRIPTION_MODEL_URL_<UPPERCASE_ID>`; the ONNX/SenseVoice URLs are
  deliberately not runtime-overridable.
- **`whisper.cpp` source.** `whisper-rs-sys 0.14.1` is a crates.io package that builds
  the bundled whisper.cpp with the `cmake` crate (that is why
  `packages/rust_transcription/cmake/linux-ci-toolchain.cmake` sets
  `GGML_NATIVE OFF` — a ggml cmake cache variable — "so the binary runs on any x86-64
  CPU, not just the CI runner's"). The source therefore arrives via **G2**, not here.
  **Verify it**: after `cargo vendor`, confirm
  `/tmp/cargo-vendor/whisper-rs-sys-0.14.1/` contains the whisper.cpp tree
  (`ls /tmp/cargo-vendor/whisper-rs-sys-0.14.1/` should show a `whisper.cpp` directory
  or `CMakeLists.txt`). If it does **not** — i.e. if upstream publishes it as a git
  submodule that `cargo package` stripped — then G5 must additionally carry the
  whisper.cpp source at the exact revision `whisper-rs-sys 0.14.1` pins, and `FETCH.md`
  must place it. Treat this as an open verification item (§12 D-6); I could not resolve
  it from inside the sandbox because `crates.io` is not on the allowlist and my GitHub
  lookups for the `whisper-rs` repository 404'd.
- **`ort-sys` binaries.** `ort = { version = "=2.0.0-rc.11", default-features = false,
  features = ["std","ndarray","load-dynamic"] }`. `load-dynamic` means no static link
  and no pyke download; the runtime is the `.so` G5.1 supplies. The repo comment is
  explicit: *"Load the official shared ONNX Runtime 1.23 artifact provisioned by
  build.rs instead of pyke's static archive: the latter is not ABI-compatible with
  Ubuntu 22.04 and has no x86_64 macOS distribution."* Verify `ort-sys` does not still
  try to fetch when `load-dynamic` is on (gate G-3 will show it).

### G6 — Browser / WebDriver group: **default = do not build**

See §12 D-2 for the decision. The measured facts:

- **No Playwright anywhere.** Zero hits for `playwright` in any `package.json`, `.ts`,
  `.mjs` or `.yml` in this repo (excluding `pnpm-lock.yaml`). The reference branch's
  227 MB `browsers/` group and its 34 MB of `chrome-deps/` are **irrelevant here**.
- E2E is WebdriverIO: `apps/desktop/webdriver/wdio.conf.js`, one spec
  (`specs/app.render.spec.ts`), run via `pnpm --filter desktop test:webdriver`.
- **`test:webdriver` is not invoked by any workflow.** Measured: zero hits for
  `test:webdriver` or `wdio` under `.github/` and `scripts/`.
- What CI actually calls `test:integration` is `vitest run test/integration`
  (`test-desktop-integration.yml`, `ubuntu-latest`, `pnpm install --frozen-lockfile`,
  `turbo run build --filter=desktop^...`, an empty `.env`, then the vitest run). No
  browser.
- On Linux `wdio.conf.js` uses **`tauri-driver`** (`~/.cargo/bin/tauri-driver`, i.e.
  `cargo install tauri-driver`) with `tauri:options`, not chromedriver. chromedriver is
  only spawned on the macOS path (`isMac`), against a vite `preview` server.
- On Linux, `tauri-driver` needs **WebKitWebDriver**, which ships inside
  `libwebkit2gtk-4.1-0` at
  `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebDriver`. G3 installs that package,
  so it is already covered — verify the path exists in the extracted sysroot.

**The one thing from this group that genuinely matters**, and it is a *build* problem,
not a browser problem:

`apps/desktop/package.json` devDependencies include `"chromedriver": "^152.0.0"`
(resolved in `pnpm-lock.yaml` to `chromedriver@152.0.0`), and the root `package.json`
lists `chromedriver` in **both** `pnpm.onlyBuiltDependencies` and
`pnpm-workspace.yaml`'s `onlyBuiltDependencies`. So its `install` script **does** run
under a normal `pnpm install --frozen-lockfile`. I fetched
`registry.npmjs.org/chromedriver/152.0.0` and read `install.js`:

```js
function getNpmEnvVar(name) {
  return process.env[name.toUpperCase()] ??
    process.env[`npm_package_config_${name}`] ??
    process.env[`npm_config_${name}`];
}
// cdnUrl        default 'https://googlechromelabs.github.io'          <- NOT allowlisted
// legacyCdnUrl  default 'https://chromedriver.storage.googleapis.com' <- NOT allowlisted
// downloadFile(): if (!url) { console.error('Download url could not be found …'); process.exit(1); }
// install():      catch (err) { console.error('ChromeDriver installation failed', err); process.exit(1); }
```

So **`pnpm install --frozen-lockfile` hard-fails in the sandbox on chromedriver.** Two
CI workflows use the full install (`release.yml` `verify-ts`, `lint-desktop.yml`,
`build-desktop.yml`, `test-desktop-integration.yml`); three jobs in
`test-desktop-unit.yml` and one in `test-docs.yml` use `--ignore-scripts`, which dodges
it.

Fix, cheapest first — `FETCH.md` must document **(a)**:

- **(a)** `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile`
  (`getNpmEnvVar('chromedriver_skip_download') === 'true'` → `process.exit(0)`
  immediately). Nothing in CI runs the wdio suite, so the missing binary costs nothing.
- **(b)** `CHROMEDRIVER_FILEPATH=/tmp/…/chromedriver` (`getNpmEnvVar('chromedriver_filepath')`)
  → uses a local zip/binary, no download. Requires vendoring
  `chromedriver-linux64.zip` for 152.0.0 from Chrome for Testing.
- **(c)** `CHROMEDRIVER_CDNBINARIESURL=<base>` → `${base}/${version}/${platform}/${basename}`.
  Only useful if the consumer has an allowlisted mirror.

Other `onlyBuiltDependencies`, assessed: `esbuild` (platform binary via npm
optionalDependencies — fine), `sharp@0.35.3` (used by `apps/docs`; `@img/sharp-linux-x64`
from npm — fine), `protobufjs` (pure-JS postinstall — fine), `@firebase/util` (pure JS
— fine), `bcrypt` and `re2` (listed defensively; **not present** in `pnpm-lock.yaml` as
direct deps — measured, zero hits — so no node-gyp build occurs; if that changes they
need `python3` + `make` + `g++`, all present).

`@tauri-apps/cli ~2.10.1`, `oxlint ^1.78.0`, `turbo ^2.10.9`, `vite`, `vitest` all
resolve platform binaries from npm optionalDependencies → **reachable**. No vendoring
needed.

If §12 D-2 says "build it anyway", the group is:

```
drivers/chromedriver-152.0.0/chromedriver-linux64.zip   + CHROMEDRIVER.txt (URL, sha256, version)
drivers/tauri-driver/                                   (cargo install tauri-driver --offline, or omit)
```

### G7 — Licences

**Layout** (mirror the reference exactly)

```
LICENSES/MPL-2.0.txt                       16,726 B  (NSS/NSPR — only if you ship chrome-deps)
LICENSES/<other SPDX>.txt                  any non-Debian redistributed text
LICENSES/debian/<package>/copyright        one file per package, name always `copyright`
```

Reference: 470 `copyright` files, 7.6 MB. Expect **600–700** here (G3 is bigger).

**Recipe**

```bash
mkdir -p out/LICENSES/debian
for p in $(awk -F'\t' '{sub(/^Package: /,"",$1); print $1}' out/system/PKGS.txt | sort -u); do
  src=$(find /tmp/gtk-sysroot/usr/share/doc -maxdepth 1 -type d -name "$p" | head -1)
  [ -n "$src" ] && [ -f "$src/copyright" ] && {
    mkdir -p "out/LICENSES/debian/$p"; cp "$src/copyright" "out/LICENSES/debian/$p/copyright"; }
done
find out/LICENSES/debian -name copyright | wc -l   # record this number in README.md
```

Also required, because these are **new redistributions the reference branch did not
carry**:

- **ONNX Runtime** → MIT. Extract `LICENSE` from `onnxruntime-linux-x64-1.23.2.tgz` to
  `LICENSES/onnxruntime/LICENSE`. Note the repo already ships
  `apps/desktop/src-tauri/binaries/onnxruntime/LICENSE.txt` — cross-check they agree.
- **sherpa-onnx** → Apache-2.0 (`patches/sherpa-onnx-sys-1.13.5/Cargo.toml` says
  `license = "Apache-2.0"`). Extract `LICENSE`/`LICENSE.txt` from the archive to
  `LICENSES/sherpa-onnx/`. It statically links **onnxruntime**, **espeak-ng** (GPL-3.0),
  **piper_phonemize**, **kissfft**, **kaldi-native-fbank**, **sentencepiece** (Apache-2.0)
  and **ucd** — the archive's own licence text is authoritative; ship whatever it
  contains and say so.
- **whisper.cpp** → MIT. If G5 ends up carrying its source (§12 D-6), ship
  `LICENSES/whisper.cpp/LICENSE`. Otherwise it arrives under G2 as a crates.io package
  with its licence inside, and `LICENSES/debian/` + the vendor tree cover it.
- The `README.md` *Licences* section must state, per the reference: the GTK/GLib/WebKit/
  cairo/pango stack is LGPL and permissive, the Debian packages carry the authoritative
  text, and every package extracted into the sysroot and into `system/tools/` has its
  `usr/share/doc/<package>/copyright` at `LICENSES/debian/<package>/copyright`.

### G8 — Manifest and documentation

#### 6.8.1 `MANIFEST.sha256`

```bash
cd out
# every file, excluding the manifest itself
find . -type f ! -name MANIFEST.sha256 -printf '%P\n' | LC_ALL=C sort | xargs -d'\n' sha256sum > /tmp/m
# plus each split archive under its REASSEMBLED name
for a in $(grep -oE '^[a-f0-9]{64}  .*\.part-00$' /tmp/m | sed 's/.*  //; s/\.part-00$//' | sort -u); do
  cat "$a".part-* > "/tmp/reasm-$(basename "$a")"
  sha256sum "/tmp/reasm-$(basename "$a")" | sed "s|/tmp/reasm-|  |; s|$(basename "$a")|$a|" >> /tmp/m
done
LC_ALL=C sort -k2 /tmp/m > MANIFEST.sha256
wc -l MANIFEST.sha256
```

Sanity-check the arithmetic the way §4 does: `lines == whole_files + parts +
reassembled_entries`. Then, from a **fresh copy**, reassemble and run
`sha256sum -c MANIFEST.sha256` and require `N of N OK` with zero failures. The
reference verified 3779 of 3779.

The consumer's reassembly one-liner (put it in `FETCH.md` verbatim — it is the
reference's and it works because the manifest lists the `.part-00` of every split
archive):

```bash
for f in $(grep -o '^[a-f0-9]\{64\}  .*\.part-00$' MANIFEST.sha256 | sed 's/.*  //; s/\.part-00$//'); do
  cat "$f".part-* > "$f"
done
sha256sum -c MANIFEST.sha256
```

#### 6.8.2 Splitting

```bash
for a in rust/cargo-vendor.tar.xz system/debian12-dev-sysroot.tar.xz \
         browsers/*.tar.xz native/*/*.tar.bz2; do
  [ -f "$a" ] || continue
  if [ "$(stat -c %s "$a")" -ge 94371840 ]; then
    split -b 90m -d -a 2 "$a" "$a.part-" && rm "$a"
  fi
done
```

`-d -a 2` yields `.part-00`, `.part-01`, … matching the reference. **Every resulting
file must be < 94371840 bytes**; assert it:

```bash
find out -type f -size +90M -printf 'TOO BIG: %s %p\n'   # must print nothing
```

#### 6.8.3 `README.md` and `FETCH.md`

Write both. Required contents are specified in §4 (structure) and §9 (`FETCH.md` step
list). Non-negotiable inclusions:

- The **reference commit** of `maus-inc/mausVoice` every version was built against, in
  the same place the reference README puts it. Use the commit you checked out; the
  numbers in this spec were measured at
  `249e465b9eca27b70c4c74da79ff9fb88517d1d5`.
- A **"What is here"** table: directory / what it holds / packed size / on-disk size
  after extraction. Measure, don't estimate.
- A **"Verification performed before this branch was pushed"** table: check / command /
  result. Fill it from §10; every row must be something you actually ran, with the
  actual output summarised. The reference records things like "137 ELF files, all
  `ELF 64-bit`/`X86-64`", "44511 / 31388 / 610 archive entries", "3779 of 3779 OK",
  "313 tests". Yours must be equally concrete.
- A **"Things the consumer must know"** section carrying at minimum:
  1. `cargo --config` / `--offline` do **not** reach external subcommands (`clippy`);
     use `$CARGO_HOME/config.toml` + `CARGO_NET_OFFLINE=true` (§4 defect 2).
  2. `CARGO_BUILD_JOBS=1` is required for `cargo test` on 3.9 GB / 2 cores (§2.1).
  3. The MSRV finding from §3.1 — whatever you measured.
  4. `MAUSVOICE_ORT_DYLIB_PATH` and `SHERPA_ONNX_ARCHIVE_DIR` are **mandatory**, not
     optional; without them `build.rs` tries GitHub Releases and fails (§2.2, §6.5).
  5. `CHROMEDRIVER_SKIP_DOWNLOAD=true` is mandatory for a scripts-enabled
     `pnpm install` (§6.6).
  6. The `--ignored` sidecar integration tests cannot run: model weights are on
     `huggingface.co` (§6.5.3).
  7. Node is v22.22.3 in the sandbox while `.nvmrc` says v24; `engines` permits it
     (§2.3).
  8. Extract to `/tmp` only; delete the download afterwards (§2.4).
- **Provenance** per artifact: upstream URL, upstream published hash where one exists,
  and the exact command used. Where a hash is your own build output rather than an
  upstream publication, say so explicitly — the reference README does exactly that for
  its self-built NSPR ("the three NSPR hashes are outputs of this build and differ from
  the reference, which the spec permits; the build is recorded here so the difference is
  explainable").
- **Size notes** naming the largest extracted consumers.

---

## 7. Branch mechanics

```bash
# Build everything under /tmp/out first (see §6). Never inside the mausVoice checkout.
git clone --filter=blob:none git@github.com:maus-inc/mausVoice.git /tmp/mv-push
cd /tmp/mv-push
git checkout --orphan vendor/sandbox-toolchain
git rm -rf --cached . >/dev/null 2>&1 || true
rm -rf ./* ./.[!.]* 2>/dev/null || true      # working tree must be EMPTY of source
cp -a /tmp/out/. .
git add -A
git -c user.name='mausagent' -c user.email='mausAgent@proton.me' \
    commit -m 'vendor: sandbox toolchain payload (G1-G8)'
git log --format='%H parents:%P'   # parents: must be EMPTY
git push origin vendor/sandbox-toolchain
```

Guards:

- The commit must have **zero parents**. Verify.
- `git ls-files | grep -vE '^(README|FETCH|MANIFEST)|^(rust|system|native|drivers|LICENSES)/'`
  must print **nothing**. No source leaked in.
- **Do not open a PR.** `secret-scan.yml` triggers on `push: branches: [main]` and
  `pull_request: {}` (no branch filter). A push to this branch fires neither, but a PR
  from it would run gitleaks over ~1 GB of hex digests and binaries. The reference
  branch's rule is "must never be merged into `main`, and it must never enter a release
  or CI workflow" — same here.
- Every other workflow in this repo filters on `push: paths:` naming source paths
  (`apps/**`, `packages/**`, `rust-toolchain.toml`, …). None of those paths exist on
  this branch, so nothing fires. Confirm after the push by listing workflow runs.
- The push will be ~1 GB. It is slow; that is normal. There is no LFS in this repo and
  you must not add any.
- Re-pushing a rebuilt payload: force-push is acceptable and expected on an orphan
  branch (`git push --force-with-lease origin vendor/sandbox-toolchain`), because
  nothing consumes its history. Say so in `README.md`.

---

## 8. Consumer-side wiring — required `FETCH.md` content

This is §9 of the reference `FETCH.md`, rewritten for mausVoice. **Everything extracts
to `/tmp`.** Number the steps the same way.

### Step 1 — Download the branch (both options, verbatim pattern)

```bash
BRANCH=vendor/sandbox-toolchain
mkdir -p /tmp/sandbox-vendor
# Option 1: one request, no git objects. Preferred.
curl -sSL -o /tmp/sandbox-vendor.tar.gz \
  "https://codeload.github.com/maus-inc/mausVoice/tar.gz/refs/heads/${BRANCH}"
tar xzf /tmp/sandbox-vendor.tar.gz -C /tmp/sandbox-vendor --strip-components=1
rm /tmp/sandbox-vendor.tar.gz          # <-- reclaim ~1 GB; the reference omits this

# Option 2: clone, single branch, no history.
git clone --depth 1 --single-branch --branch vendor/sandbox-toolchain \
  https://github.com/maus-inc/mausVoice.git /tmp/sandbox-vendor
```

Do **not** use `--filter=blob:none` here and then read files: a partial clone fetches
blobs one at a time on demand and, against a 3700-blob promisor branch, that is
catastrophically slow (measured: it did not finish in 180 s for a `git ls-tree -r -l`).
If you only need the tree listing, use the API instead:
`https://api.github.com/repos/maus-inc/mausVoice/git/trees/<sha>?recursive=1`.

For one or two small files, skip the whole download:

```bash
gh api repos/maus-inc/mausVoice/contents/rust/Cargo.lock.sha256 \
  --jq .content -H 'Accept: application/vnd.github+json' \
  -f ref=vendor/sandbox-toolchain | base64 -d
```

(`gh api` needs `?ref=` passed as a field; the reference's one-liner omits it because
its default branch was different. Test yours.)

### Step 2 — Reassemble and verify

The §6.8.1 one-liner, then `sha256sum -c MANIFEST.sha256`. Zero failures required.

### Step 3 — Rust toolchain

```bash
RUST_PREFIX=/tmp/rust-tools; mkdir -p "$RUST_PREFIX"
for t in /tmp/sandbox-vendor/rust/toolchain/*-1.88.0-*.tar.xz; do
  d=$(mktemp -d); tar xJf "$t" -C "$d"
  "$d"/*/install.sh --prefix="$RUST_PREFIX" --disable-ldconfig; rm -rf "$d"
done
export PATH="$RUST_PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$RUST_PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
rustc --version    # rustc 1.88.0
cargo --version    # cargo 1.88.0
cargo clippy --version
cargo fmt --version
```

Do **not** set `RUSTUP_HOME`/`CARGO_HOME` at the workspace. `.gitignore` reserves
`.tooling/` for that purpose but the rule is still `/tmp`.

### Step 4 — Cargo vendor tree, offline

```bash
mkdir -p /tmp/cargo-vendor
tar xJf /tmp/sandbox-vendor/rust/cargo-vendor.tar.xz -C /tmp/cargo-vendor

export CARGO_HOME=/tmp/cargo-home; mkdir -p "$CARGO_HOME"
# Use the shipped stanza, with `directory` rewritten to the real extraction path.
sed 's|^directory = .*|directory = "/tmp/cargo-vendor"|' \
  /tmp/sandbox-vendor/rust/cargo-config.toml > "$CARGO_HOME/config.toml"
export CARGO_NET_OFFLINE=true

# Refuse lockfiles that do not match the vendor tree.
cd /path/to/mausVoice
sha256sum -c /tmp/sandbox-vendor/rust/Cargo.lock.sha256
```

The config **must** keep the `ferrous-focus` git stanza (§6.2.2). If you flatten it to
crates-io only, offline resolution of the git dep fails.

Also worth documenting: the repo's own sandbox doc
(`docs/Installing-cargo-toolchain-for-kilocode-bot-agents-in-a-linux-sandbox.md`, step 4)
recommends `[net] git-fetch-with-cli = true` in `apps/desktop/src-tauri/.cargo/config.toml`
because `libgit2` fetches fail in restricted sandboxes. With a complete vendor tree that
is unnecessary — and **committing `.cargo/config.toml` into the repo is explicitly
forbidden** (reference *Cautions*: "Do not commit `.cargo/config.toml` into the
repository. CI expects crates.io."). If the consumer needs it, it goes in
`$CARGO_HOME/config.toml` under `/tmp`, never in the checkout.

### Step 5 — Sysroot

```bash
mkdir -p /tmp/gtk-sysroot
tar xJf /tmp/sandbox-vendor/system/debian12-dev-sysroot.tar.xz -C /tmp/gtk-sysroot
export PKG_CONFIG_SYSROOT_DIR=/tmp/gtk-sysroot
export PKG_CONFIG_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/tmp/gtk-sysroot/usr/share/pkgconfig
export PKG_CONFIG=/tmp/gtk-sysroot/usr/bin/pkg-config
export CPATH=/tmp/gtk-sysroot/usr/include:/tmp/gtk-sysroot/usr/include/x86_64-linux-gnu
export LIBRARY_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu
export LD_LIBRARY_PATH=/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
# NEW vs the reference: bindgen/clang-sys must find libclang.
export LIBCLANG_PATH=/tmp/gtk-sysroot/usr/lib/llvm-14/lib     # <-- use the path G3 §6.3.5(3) recorded
```

If `pkg-config` still cannot find a module, the usual cause is that the `.pc` file lives
in a multiarch dir you did not add to `PKG_CONFIG_PATH`. Add
`/tmp/gtk-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig` **and**
`/tmp/gtk-sysroot/usr/share/pkgconfig` (both are above) and, if G3 pulled in
`lib/pkgconfig`, that too.

### Step 6 — Command-line tools

```bash
export PATH=/tmp/sandbox-vendor/system/tools/bin:$PATH
pkg-config --version; cmake --version; patchelf --version; file --version
```

No `LD_LIBRARY_PATH` needed — the tree is rpath'd `$ORIGIN/../lib`. Copy the whole tree,
never single files (`bin/pkg-config` is a symlink to `bin/pkgconf`).

`cmake` must be on `PATH` **before** any cargo build of `rust_transcription`: the
`cmake` crate resolves `cmake` from the environment.

### Step 7 — Native build payloads (NEW; mausVoice-only)

```bash
# ONNX Runtime 1.23.2 -> libonnxruntime.so
mkdir -p /tmp/ort && tar xzf /tmp/sandbox-vendor/native/onnxruntime/onnxruntime-linux-x64-1.23.2.tgz -C /tmp/ort
export MAUSVOICE_ORT_DYLIB_PATH="$(find /tmp/ort -name libonnxruntime.so | head -1)"
[ -f "$MAUSVOICE_ORT_DYLIB_PATH" ] || { echo "ORT .so not found"; exit 1; }

# sherpa-onnx v1.13.5 static libs for linux-x64 -> point build.rs at the archive,
# so its pinned sha256 check still runs.
export SHERPA_ONNX_ARCHIVE_DIR=/tmp/sandbox-vendor/native/sherpa-onnx

# ggml/whisper.cpp: keep the binary portable across CPUs, exactly as CI does.
export CMAKE_TOOLCHAIN_FILE=/path/to/mausVoice/packages/rust_transcription/cmake/linux-ci-toolchain.cmake
```

`CMAKE_TOOLCHAIN_FILE` is set by every CI job that builds the sidecar
(`build-desktop.yml`, `test-package-rust-transcription.yml`, `release.yml`) and its only
content is `set(GGML_NATIVE OFF CACHE BOOL "" FORCE)`. Omitting it produces a binary
tuned to the build host — harmless in a sandbox, but divergent from CI, so set it.

### Step 8 — Node / pnpm

```bash
node --version          # v22.22.3 in the sandbox; satisfies root engines ^22.22.2
corepack enable
corepack prepare pnpm@10.34.5 --activate    # registry.npmjs.org IS allowlisted
pnpm --version          # 10.34.5, matching root packageManager
```

Then, from the repo root:

```bash
export CHROMEDRIVER_SKIP_DOWNLOAD=true      # <-- mandatory, see §6.6
pnpm install --frozen-lockfile
```

`pnpm install --frozen-lockfile --ignore-scripts` also works and is what
`test-desktop-unit.yml` uses; it skips the `esbuild`/`sharp` postinstalls too, which is
fine for `vitest`/`tsc` but **not** fine if you then run `turbo run build`.

### Step 9 — Build, lint, test

The exact gates are §10. In short:

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
`binaries/rust-transcription-cpu` and `binaries/rust-transcription-gpu` to exist
(`tauri.conf.json` `bundle.externalBin`), which they do not in a fresh checkout —
`apps/desktop/src-tauri/binaries/` contains only `onnxruntime/LICENSE.txt`.

### Step 10 — Sanity checks and cautions

Carry over the reference's *Sanity checks* block, adapted: the `pkg-config --modversion`
loop from §6.3.5(1), the two `find` symlink checks, the `gcc` link check, and
`readelf -h` over every ELF. Drop the Chrome-closure check unless D-2 said build G6.

*Cautions* (reference list, extended):

- Do not extract into the workspace. Use `/tmp`.
- Do not commit `.cargo/config.toml` into the repository. CI expects crates.io.
- Do not point `CARGO_HOME` at the workspace.
- `system/tools/bin/pkg-config` is a symlink to `pkgconf` in the same directory. Copy
  the whole tree.
- **Do not unset `MAUSVOICE_ORT_DYLIB_PATH` or `SHERPA_ONNX_ARCHIVE_DIR` mid-session.**
  A later `cargo build` of `rust_transcription` will try GitHub Releases and fail after
  minutes of compiling.
- **Do not delete `patches/`.** Two crates are path-patched from there and `rdev` is a
  path dependency; the vendor tree deliberately does not contain them.
- One `CARGO_TARGET_DIR` shared across the seven crates saves gigabytes and a lot of
  time; but note `sherpa-onnx-prebuilt/` and `mausvoice-onnxruntime/` caches are keyed
  off it (§6.5), so if you change it, re-seed.

---

## 9. Reference `FETCH.md` step numbering

Match the reference's shape so a reader who knows one knows the other:

1. Download the branch
2. Reassemble the split archives and verify
3. Wire up the Rust toolchain
4. Wire up the cargo vendor tree, offline
5. Wire up the Debian 12 development sysroot
6. Command line tools
7. **Native build payloads (ONNX Runtime + sherpa-onnx)** ← replaces the reference's
   "Playwright browsers and the library closure"
8. **Node and pnpm** ← new
9. Build, lint and test
10. Sanity checks
11. Cautions

---

## 10. Verification gate matrix — what the branch must make pass

Run **all** of these inside a clean `debian:12` container with *only* the vendored
inputs and a checkout of mausVoice, before you push. Fill the results into `README.md`.
Each row cites the workflow that makes it a real gate.

| ID | Gate | Command | Source of truth |
| --- | --- | --- | --- |
| G-0 | Manifest | `sha256sum -c MANIFEST.sha256` after reassembly → N of N OK | §6.8.1 |
| G-0b | Archives | `tar tJf` / `tar tzf` each reassembled archive → no errors; record entry counts | reference did this |
| G-0c | Arch | `readelf -h` on every ELF → all `ELF 64-bit` / `X86-64`; record the count | reference: 137 files |
| G-0d | Tools | `pkg-config`, `cmake`, `patchelf`, `file` run in a clean container with none of them installed, and under `env -i` | §6.4 |
| G-0e | Sysroot | `pkg-config --modversion` for the ~35 modules in §6.3.5(1) → every one prints a version; record the table | §6.3.5 |
| G-0f | Sysroot links | the `find -xtype l` / `-lname '/*'` checks and the `gcc` link check | §6.3.5 |
| **G-1** | Toolchain versions | `rustc/cargo --version` → 1.88.0; `cargo clippy --version`; `cargo fmt --version` | §6.1 |
| **G-2** | Offline resolve | `CARGO_NET_OFFLINE=true cargo metadata --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --format-version 1 >/dev/null` for **all seven** manifests → exit 0. This is the test that the vendor tree, the git stanza and the path patches all resolve. (`cargo metadata` **is** a built-in, so it honours offline mode — unlike `clippy`.) | §6.2 |
| **G-3** | fmt (6 crates) | `cd <crate> && cargo fmt --check` for `apps/desktop/src-tauri`, `packages/rust_pill_shared`, `packages/rust_gtk_pill`, `packages/rust_macos_pill`, `packages/rust_windows_pill`, `packages/rust_transcription` | `test-desktop-unit.yml` "Check Rust formatting" — *"Every crate, not just the one the tests below run"* |
| **G-4** | clippy desktop | `cd apps/desktop/src-tauri && TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo clippy --locked -- -D warnings` | `lint-desktop.yml` "Lint Rust" |
| G-4b | clippy all-targets | `… cargo clippy --locked --all-targets -- -D warnings` (desktop + `rust_pill_shared`) | `test-desktop-unit.yml` "Lint every Rust target" |
| G-4c | clippy gtk pill | `cargo clippy --locked --manifest-path packages/rust_gtk_pill/Cargo.toml --all-targets -- -D warnings` — needs `libgtk-layer-shell-dev` | `lint-desktop.yml` "Lint native pill (Linux)" |
| **G-5** | test desktop lib | `cd apps/desktop/src-tauri && TAURI_CONFIG=… CARGO_BUILD_JOBS=1 cargo test --locked --lib` | `release.yml` + `test-desktop-unit.yml`. **Record the test count** |
| G-5b | test transcription | `CMAKE_TOOLCHAIN_FILE=… CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --lib` | `release.yml`, `test-package-rust-transcription.yml`. **This is the gate that proves G5 works** — it compiles `whisper-rs-sys` (cmake + whisper.cpp), `ort-sys`, `bindgen` (libclang) and `sherpa-onnx-sys` (patched, archive from `SHERPA_ONNX_ARCHIVE_DIR`) |
| G-5c | test pill_shared | `cargo test --locked --manifest-path packages/rust_pill_shared/Cargo.toml` | `release.yml`, `lint-desktop.yml` |
| G-5d | test gtk pill | `xvfb-run -a cargo test --locked --manifest-path packages/rust_gtk_pill/Cargo.toml` | `release.yml` "Run Linux pill tests" (needs `xvfb` in G3; §12 D-4) |
| G-5e | sidecar integration | `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --test sidecar_integration -- --nocapture --test-threads=1` (**non**-ignored only) | `test-package-rust-transcription.yml` |
| G-5x | **Expected to fail** | same with `-- --ignored` → **cannot pass**: model weights live on `huggingface.co`. Record as a known exclusion, not a failure | §6.5.3 |
| G-6 | sherpa build-script tests | `node --test scripts/ci/sherpa-build-script-tests.test.mjs` and `node scripts/ci/sherpa-build-script-tests.mjs` (the latter needs a warm cargo cache from G-5b: it runs `cargo build -vv` on a copy of the patch crate and resolves build-deps offline) | `test-package-rust-transcription.yml` |
| G-6b | sherpa link mode | `node --test scripts/ci/sherpa-onnx-link-mode.test.mjs` | same |
| G-6c | archive digests | `node --test scripts/ci/verify-sherpa-archives.test.mjs` | `test-desktop-unit.yml` |
| G-7 | Node-only CI guards | `node --test` over: `run-with-diagnostics.test.mjs`, `dev-surface-contracts.test.mjs` (needs `smol-toml` from the workspace install), `package-exports.test.mjs`, `check-bindings-guard.test.mjs`, `check-workflow-pins.test.mjs`, `validate-release-inputs.test.mjs`, `release-notes.test.mjs`, `check-workspace-hygiene.test.mjs`, `windows-tauri-imports.test.mjs`, `build-changelog.test.mjs`, `check-gitleaks-config.test.mjs`, `pr28-contracts.test.mjs`, `pr37-contracts.test.mjs`, `release-shell-contracts.test.mjs`, `updater-manifest.test.mjs` | `test-desktop-unit.yml` |
| G-8 | pnpm install | `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` → exit 0, no chromedriver download attempted | §6.6 |
| G-9 | turbo build | `pnpm exec turbo run build --filter=desktop^... --verbosity=2 --continue` | `test-desktop-unit.yml`, `release.yml` |
| G-10 | TS gates | `pnpm --filter desktop run lint` (prettier --check src test && oxlint src test && node scripts/ui-lint.mjs); `pnpm --filter desktop run check-types` (tsc --noEmit); `pnpm --filter desktop run test:unit`; `pnpm --filter @maus-inc/voice-ai run test`; `pnpm --filter @repo/agent test`; `pnpm --filter @maus-inc/preview test` | `release.yml` verify-ts, `test-desktop-unit.yml`, `AGENTS.md` Verification Gate |
| G-11 | bindings | `TAURI_CONFIG=… bash scripts/check-bindings.sh` → `git diff --exit-code -- packages/desktop-native-apis/src/bindings.ts`. Needs `cargo run --example gen_bindings` **and `python3`** (present) | `test-desktop-unit.yml` "Verify generated bindings are in sync" |
| G-12 | i18n | `pnpm --filter desktop i18n` then `git diff --exit-code -- apps/desktop/src/i18n/locales` and no untracked files there | `test-desktop-unit.yml` "i18n-sync" |
| G-13 | icons | `node scripts/generate-app-icons.mjs --check` (needs `imagemagick` → G3) | `lint-desktop.yml` "Verify app icons" |
| G-14 | integration vitest | `pnpm --filter desktop run test:integration` (`vitest run test/integration`) — needs an empty `.env` | `test-desktop-integration.yml` |

`AGENTS.md`'s own **Verification Gate** (§"Verification and quality") is the shorter
list an agent is told to run before pushing; make sure G-10 covers it exactly:

```
pnpm --filter desktop check-types
pnpm --filter desktop lint
pnpm --filter desktop test          # all unit tests; GROQ_API_KEY integration tests may be unavailable
pnpm --filter @maus-inc/voice-ai test
pnpm --filter @repo/agent test
```

Note the `GROQ_API_KEY` caveat: some voice-ai tests need an API key and are expected to
be skipped in a sandbox. Record that too. `req.txt` pins a Python stack
(`groq==1.0.0`, `pydantic==2.12.5`, `httpx==0.28.1`, `python-dotenv==1.2.1`, …) used by
`scripts/prompts.py` / `scripts/translate.py`; those are developer utilities, not gates,
and `pypi.org` **is** allowlisted, so no vendoring is needed.

---

## 11. Ordering and effort

Build in this order; each stage is independently verifiable and a later stage depends on
the earlier one.

| Stage | Work | Depends on | Rough effort |
| --- | --- | --- | --- |
| 0 | Clean `debian:12` container; clone mausVoice at the reference commit; record the commit sha | — | 10 min |
| 1 | **G1** Rust 1.88.0 (5 downloads + hash table) | 0 | 20 min |
| 2 | **G4** tools tree | 0 | 45 min |
| 3 | **G3** sysroot + `fix-sysroot-links.py` + `PKGS.txt` | 2 (needs `patchelf`? no — but needs the same container discipline) | 2–4 h (the symlink fixer is the work) |
| 4 | **G2** cargo vendor union + config + lockfile hashes | 1 | 45 min |
| 5 | **G5** ORT + sherpa archives | 0 | 20 min |
| 6 | **G7** licences | 3, 5 | 30 min |
| 7 | Gates G-1..G-6 in a *fresh* container using only stages 1–6 | 1–6 | 2–4 h |
| 8 | **G8** manifest, split, `README.md`, `FETCH.md` | 7 | 1 h |
| 9 | Gates G-7..G-14 (Node half) | 8 | 1–2 h |
| 10 | Push the orphan branch; confirm no workflow fired | 9 | 30 min |

The single highest-risk item is **stage 3's symlink fixer**, and the second is
**G-5b** (gate that proves bindgen/cmake/whisper.cpp/sherpa/ort all work offline). If
G-5b fails, everything else is cosmetics.

---

## 12. Decisions to settle before you build

**D-1 — Rust channel: 1.88.0 (recommended) vs current stable.**
`rust-toolchain.toml` pins 1.88.0 and explains why. Ship 1.88.0. If gate G-4 then fails
on an MSRV error, escalate the channel and document it (§3.1). *Shipping stable would
silently change clippy output and is exactly what the pin exists to prevent.*

**D-2 — Build the browser/driver group (G6)?** Recommended **no**. Measured: no
Playwright; `test:webdriver` is wired into zero workflows; Linux wdio uses
`tauri-driver` + WebKitWebDriver (already in G3), not chromedriver. The only real
chromedriver issue is the *install script*, solved by an env var (§6.6), not by 250 MB
of payload. Build it only if someone intends to run the wdio suite in the sandbox.

**D-3 — Vendor Node and/or pnpm?** Recommended **no**. Node v22.22.3 is present and
satisfies `engines`; `corepack` + `registry.npmjs.org` gets pnpm@10.34.5. Vendoring Node
is awkward anyway: `nodejs.org` is not allowlisted and Node publishes no Linux binaries
as GitHub Release assets.

**D-4 — Put `xvfb`/`xauth` in the sysroot, or drop gate G-5d?**
`release.yml` runs `xvfb-run -a cargo test --manifest-path packages/rust_gtk_pill/Cargo.toml`
and comments that the tests are pure math/state and *"never open a display"*, with xvfb
as insurance. Including `xvfb`+`xauth` costs maybe 20 MB packed and makes the release
gate reproducible. Recommended **include**. If you drop it, `README.md` must say G-5d is
uncovered.

**D-5 — Include bundling-only packages (`libfuse2`, `rpm`, `wtype`, AppImage tooling)?**
Recommended **no** for the default branch. `build-desktop.yml` bundles `--bundles deb`
on Linux, which needs `dpkg-deb` (present in the base image) but not `rpm`/`libfuse2`.
Bundling also needs a full release build (~GBs of `target/`) which is out of scope for
the gates. Document as a follow-up group if someone later wants sandbox bundling.

**D-6 — Does `whisper-rs-sys 0.14.1` ship whisper.cpp source inside the crate?**
Must be verified during stage 4 (§6.5.3). If yes: nothing to do. If no: G5 grows a
`native/whisper.cpp/` group pinned to the revision `whisper-rs-sys 0.14.1` expects, and
`FETCH.md` needs a step to place it. I could not settle this from inside the sandbox
(`crates.io` unreachable; my GitHub lookups for the `whisper-rs` repo 404'd — the
repository may have moved or been renamed). **Resolve this first; it is the only unknown
that can change the branch layout.**

**D-7 — Branch owner identity.** The reference commit is authored
`mausagent <mausAgent@proton.me>`. Use whatever identity this repo's automation uses;
record it in `README.md`.

**D-8 — Where does the consumer documentation live on `main`?**
This spec is `docs/sandbox-toolchain-vendor-spec.md`. Once the branch exists, a short
pointer should be added on `main` (candidate: a section in
`docs/Installing-cargo-toolchain-for-kilocode-bot-agents-in-a-linux-sandbox.md`, which
currently assumes unrestricted internet and tells the reader to `curl sh.rustup.rs` —
that command **cannot work** in this sandbox). That is a normal PR on a normal branch,
**not** part of the orphan branch. Recommended: yes, and mark the rustup steps in that
doc as "requires unrestricted network; see `vendor/sandbox-toolchain` otherwise".

---

## 13. Appendix A — reference branch inventory (for diffing your output)

Directory-level summary of `better-Shape/app@7c4c8788b138`:

| Path | Files (blobs) | Bytes |
| --- | --- | --- |
| `system/` (top level: `PKGS.txt` + 4 sysroot parts) | 5 | 304,188,066 |
| `browsers/` (`BROWSERS.txt` + 3 parts) | 4 | 227,379,621 |
| `rust/toolchain/` | 6 | 128,582,242 |
| `rust/` (top level: 2 cargo-vendor parts + 2 text files) | 4 | 99,319,229 |
| `system/tools/` | 3193 | 79,518,900 |
| `chrome-deps/` (`cft-156/` 82 + `npm-chromium-153/` 9) | 91 | 34,723,727 |
| `LICENSES/debian/` | 470 | 7,604,637 |
| root (`README.md`, `FETCH.md`, `MANIFEST.sha256`) | 3 | 506,824 |
| `LICENSES/` (top level: `MPL-2.0.txt`) | 1 | 16,726 |
| **Total** | **3777** | **881,839,972** |

Blob counts, not tree entries — the API's `LICENSES/debian` node reports 941 *entries*
because it counts the 470 package directories plus their parent as well as the 470
blobs. Likewise `system/tools` reports 3246 entries for 3193 blobs across 52
directories. `LICENSES/debian/` holds **exactly one blob per package directory, and
every one of the 470 is named `copyright`** (measured: basename histogram =
`copyright: 470`). So `PKGS.txt`'s 496 packages vs 470 `copyright` files means 26
packages contributed no `usr/share/doc/<package>/copyright` — typically virtual or
metapackages such as `build-essential`. Decide whether to mirror that behaviour or to
record the gap; the reference did not explain it.

Reference provenance details worth preserving as *patterns*:

- Rust components verified against upstream `xz_hash` from `channel-rust-<v>.toml` — all
  five matched.
- Sysroot built by `dpkg-deb -x` over `/var/cache/apt/archives/*.deb`, then the
  symlink fixer, then `tar -cJf`.
- Chrome set A: NSS from npm `chrome-aws-lambda@10.1.0` `bin/aws.tar.br`
  (brotli-compressed — note the sandbox has **no brotli tool**; another reason to skip
  G6); NSPR **built from source** at `servo/nspr` commit
  `8219c5c5137b94ae93cfb4afc1dc10a94384e1c6` with `USE_64=1 ./configure --enable-64bit
  && make -j2 && make install`, gcc 12.2.0, stripped. Its README records that the three
  NSPR hashes therefore differ from any published reference and says so explicitly.
  **That is the standard to meet**: when you cannot match an upstream hash, publish your
  build recipe instead of hiding the difference.
- Chrome set B: closure *computed*, not guessed —
  `ldd chrome-linux64/chrome | grep "not found"` plus
  `readelf -d chrome-linux64/chrome | grep NEEDED`, minus glibc/loader/libstdc++
  (base image provides) minus EGL/GLESv2/Vulkan (CfT archive ships them). 81 libraries.
- Playwright tree: layout must include the empty `INSTALLATION_COMPLETE` marker **inside
  each browser directory, not inside `chrome-linux64/`**, and the headless-shell
  directory name uses **underscores** (`chromium_headless_shell-1248`). Playwright
  publishes no `.sha256` sidecar for those zips (the request 404s or 307s), so only the
  measured sha256 of the downloaded zip was recorded.

---

## 14. Appendix B — mausVoice facts the builder will need and cannot guess

Repo identity: `maus-inc/mausVoice`, default branch `main`, this spec written against
`249e465b9eca27b70c4c74da79ff9fb88517d1d5`. App version `0.1.6`. Tauri `=2.10.3`,
`tauri-build =2.5.6`, `@tauri-apps/api ~2.10.1`, `@tauri-apps/cli ~2.10.1`.

Workspace: pnpm `10.34.5` (root `packageManager`), `pnpm-workspace.yaml` globs
`apps/*`, `apps/firebase/functions`, `packages/*`. Turborepo `^2.10.9`,
`turbo.json` `concurrency: 15`, `ui: tui`, `globalEnv: TAURI_PLATFORM,
MAUSVOICE_DESKTOP_PLATFORM, FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST,
GCLOUD_PROJECT, REALTIME_DATABASE_EMULATOR_HOST`. `.npmrc`:
`strict-peer-dependencies=true` (so a peer mismatch **fails** the install — if
`pnpm install --frozen-lockfile` errors on peers, that is the cause, not the vendor tree).

Workspace packages and their gate scripts (measured):

| Path | Name | Relevant scripts |
| --- | --- | --- |
| `apps/desktop` | `desktop` | `lint` = `prettier --check src test && oxlint src test && node scripts/ui-lint.mjs`; `check-types` = `tsc --noEmit`; `test` = `vitest run`; `test:unit` = `vitest run src scripts --exclude scripts/run-tauri-dev.test.mjs --exclude scripts/run-tauri-with-sidecars.test.mjs && node --test scripts/run-tauri-dev.test.mjs scripts/run-tauri-with-sidecars.test.mjs`; `test:integration` = `vitest run test/integration`; `test:evals` = `vitest run test/evals`; `test:webdriver` = `wdio run webdriver/wdio.conf.js` (**not in CI**); `build` = `tsc && node scripts/run-vite-with-flavor.mjs build`; `i18n` = `i18n:extract && i18n:sync`; `prepare:sidecars` = `node scripts/prepare-sidecars.mjs` |
| `apps/preview` | `@maus-inc/preview` | `test` = `vitest run`; `check-types` = `tsc --noEmit`; `build` = `vite build` |
| `apps/docs` | `docs` | `check-types` = `astro check`; `build` = `astro build`; `lint` = `echo 'no lint configured'`. Uses `sharp ^0.35.3` |
| `apps/windows-installer` | `@maus-inc/windows-installer` | `build` = `vite build` |
| `packages/agent` | `@repo/agent` | `test` = `vitest run`; `build` = `tsc` |
| `packages/voice-ai` | `@maus-inc/voice-ai` | `test` = `vitest run`; `build` = `tsc` |
| `packages/utilities` | `@maus-inc/utilities` | `test` = `vitest run`; `build` = `tsc` |
| `packages/desktop-native-apis` | `@maus-inc/desktop-native-apis` | `build` = `tsc`; target of `pnpm gen:bindings` |
| `packages/desktop-utils`, `types`, `firemix` | `@maus-inc/*` | `build` = `tsc` |
| `packages/eslint-config`, `typescript-config`, `shared-fonts` | — | no scripts |

Desktop crate highlights (`apps/desktop/src-tauri/Cargo.toml`): `[lib] name =
"desktop_lib"`, `crate-type = ["staticlib","cdylib","rlib"]`, `default-run = "mausVoice"`,
feature `debug-assist = ["tauri/devtools"]` (**never in a stable release**), tauri
features `protocol-asset, tray-icon, image-png, macos-private-api`. Exact-version pins
to be aware of when the lock moves: `tauri =2.10.3`, `tauri-build =2.5.6`,
`tauri-plugin-dialog =2.4.2`, `minisign-verify =0.2.5`, `specta =2.0.0-rc.22`,
`specta-typescript =0.0.9`, `tauri-specta =2.0.0-rc.21`, `cap-std =4.0.3`,
`cap-fs-ext =4.0.3`. Linux-only deps: `rfd 0.15` (`gtk3`, no defaults), `arboard 3`,
`enigo 0.1`, `gtk 0.18`, `libpulse-binding 2`, `libpulse-simple-binding 2`,
`x11 2` (`xlib`). `[lints.rust] unexpected_cfgs = warn` with an explicit `check-cfg`
list — a new cfg key will warn, and clippy runs with `-D warnings`.

`packages/rust_transcription`: bins `rust-transcription-cpu` (`src/bin/cpu.rs`) and
`rust-transcription-gpu` (`src/bin/gpu.rs`, `required-features = ["gpu"]`); features
`gpu`, `gpu-metal`, `gpu-vulkan`; deps `axum 0.7`, `whisper-rs =0.15.1`
(`default-features = false, features = ["raw-api"]`), `ort =2.0.0-rc.11`
(`std, ndarray, load-dynamic`), `parakeet-rs =0.3.3` (`cpu, load-dynamic`),
`canary-rs =0.2.0` (`cpu, load-dynamic`), `sherpa-onnx =1.13.5`
(`default-features = false`, `static` on non-Windows/non-Android, `shared` on
Windows/Android); build-deps `flate2 1`, `sha2 0.10`, `tar 0.4`, `ureq 3.1`,
`zip 4.6`; dev-deps `http-body-util`, `tower`, `hound`, `tempfile`. Tests:
`tests/sidecar_integration.rs`. Assets: `assets/audio.wav`, `assets/test.wav`.
Also `benchmark.py`.

Sidecar wiring: `tauri.conf.json` `bundle.externalBin = ["binaries/rust-transcription-cpu",
"binaries/rust-transcription-gpu"]`, `bundle.targets = "all"`,
`createUpdaterArtifacts = false`. `apps/desktop/scripts/prepare-sidecars.mjs` reads the
sidecar manifest from `packages/rust_transcription/Cargo.toml`, builds into
`packages/rust_transcription/target` (or `$CARGO_TARGET_DIR`), copies binaries to
`apps/desktop/src-tauri/binaries/`, and copies the ONNX Runtime library to
`apps/desktop/src-tauri/binaries/onnxruntime/libonnxruntime.so` (it fails if the library
was "not provisioned by the sidecar build"). Env it reads: `CARGO_TARGET_DIR`,
`CARGO_BUILD_TARGET`, `TAURI_ENV_TARGET_TRIPLE`, `MAUSVOICE_SIDECAR_PROFILE`
(`release`|debug), `MAUSVOICE_REQUIRE_GPU_SIDECAR`. On Windows it additionally requires
`onnxruntime.dll` and `sherpa-onnx-c-api.dll` (fail-closed) and accepts
`onnxruntime_providers_shared.dll`, `sherpa-onnx-cxx-api.dll`. It retries cargo on
failure with the comment *"transient network may have caused sherpa download 500"* —
i.e. the repo already knows this download is the fragile part.

CI action pins (all SHA-pinned; `scripts/ci/check-workflow-pins.test.mjs` enforces this,
so do not "helpfully" unpin anything): `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0`,
`pnpm/action-setup@a8198c4bff370c8506180b035930dea56dbd5288 # v5`,
`actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5`,
`dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable`,
`Swatinem/rust-cache@49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c # v2`,
`oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2`.
Runner images: `ubuntu-22.04` (build/lint desktop), `ubuntu-latest` (unit, integration,
transcription, release verify), `macos-14`, `windows-latest`/`windows-2022`.
**None of these is Debian 12** — the consumer sandbox is. That is fine for compile/test
gates but it is why the sysroot must be built on `debian:12` and not copied from a
runner.

`scripts/ci/run-with-diagnostics.sh` wraps several CI cargo steps
(`rust-unit`, `clippy`, `windows-native-pill`, `transcription-unit`,
`sherpa-build-script-tests`, `sidecar`, `bindings`). It is a diagnostic wrapper; the
underlying command is what matters, and it is listed in §10.

Finally: `docs/Installing-cargo-toolchain-for-kilocode-bot-agents-in-a-linux-sandbox.md`
(283 lines) is the existing sandbox doc. It assumes unrestricted internet
(`curl https://sh.rustup.rs | sh`, `apt-get install`) and therefore **does not work in
this sandbox**. Its package table is still a useful cross-check for G3, and its
"Common Errors and Fixes" section (`pkg-config exited with status code 1` for
`glib-2.0`/`libsoup-3.0`/`alsa`, `rust-lld: error: unable to find library -lxdo`,
`warning: no default linker ('cc') was found`, `could not read refs from remote
repository`) is a good template for your `README.md`'s trap list — those are the exact
symptoms an incomplete G3 produces. See D-8.

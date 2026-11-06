# Sandbox vendor handoff prompt

Use this when the vendor payload has to be rebuilt. The build cannot happen inside the
Arena agent sandbox described in `engineering/sandbox-vendored-toolchain.md`, because
it needs `static.rust-lang.org`, `crates.io`, Debian mirrors and GitHub Release assets.
Hand it to an agent on a host that reaches all four, and confirm the handoff before it
starts: fetch one pinned release asset with `curl -sSIL -o /dev/null -w '%{http_code}'`
and print the final code, because a host probe says nothing about where a redirect lands.

The exhaustive specification is `docs/sandbox-toolchain-vendor-spec.md`. It is the
document to hand over. This file is the short prompt that wraps it, plus the
verification to run when the build comes back.

## When a rebuild is needed

Rebuild when any of these changes:

- A `Cargo.lock` in one of the seven Rust workspaces. The vendored crate tree is
  resolved `--locked` against the union of all seven, so one changed lock invalidates
  the tree.
- `rust-toolchain.toml`. It pins 1.88.0 with the `clippy` and `rustfmt` components.
- A native pin in `packages/rust_transcription/build.rs` (ONNX Runtime) or
  `patches/sherpa-onnx-sys-1.13.5/build.rs` (sherpa-onnx).
- The GTK, Tauri or WebKit link set, which changes the Debian sysroot package list.
- A new `build.rs` that downloads from a host the Arena agent sandbox cannot reach.

Do not rebuild for a TypeScript-only change, a docs change, or a migration.

## The second delivery, groups G9 to G13

G1 to G8 cover the gates the branch already passes. `engineering/sandbox-coverage-gaps.md`
records the stages it cannot cover, and the specification now carries a group for each.
The second delivery shipped these five groups on 2026-11-05, so the table records what each
one carries and its measured size. Extend the same branch and manifest if a task needs more.

| Group | Carries                                                                    | Opens                                                          | Measured                        |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------- |
| G9    | `ffmpeg`, `ffprobe`, `gifsicle`                                            | the capture encode and GIF assembly; a browser is still absent | 160 MB                          |
| G10   | `ggml-tiny.bin`, `ggml-base.bin`, the SenseVoice bundle, `MODELS.txt`      | whisper and SenseVoice loads, not all four ignored tests       | 463 MB                          |
| G11   | `tauri-driver` 2.0.6, optional `chromedriver` 152.0.0                      | `test:webdriver` on Linux                                      | 24 MB                           |
| G12   | `rust-std` for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`, 1.88.0 | `cargo check --target` on platform gated code                  | 47.5 MB packed, 245 MB unpacked |
| G13   | `gitleaks` 8.18.0                                                          | the history scan                                               | 7 MB                            |

`tesseract` and its `tessdata` are not shipped, so the `ui-capture` OCR check is still
absent, and no Chromium ships, so the capture itself still needs a browser from elsewhere.
The payload carries `tauri-driver` 2.0.6 rather than 2.1.0, because 2.1.0 needs
rustc 1.90 and this repository pins 1.88.0.

Keep the same branch, the same orphan commit rule, and the same manifest. Amending one orphan
commit of this size is cheaper than a second branch, so fold a further delivery into the
existing commit and move the tip.

Nothing in G9 to G13 changes the trust model. Every binary and every model needs an upstream
URL, a published digest where one exists, and a line in `MANIFEST.sha256`. Where the digest is
your own build output, say so in `README.md`, the same way the licence group does.

## The prompt to hand over

> Build the `vendor/sandbox-toolchain` orphan branch for `maus-inc/mausVoice`,
> following `docs/sandbox-toolchain-vendor-spec.md` exactly. Re-pin everything to this
> repository's current versions. Do not copy the equivalent branch on
> `better-Shape/app`, which is a different application on a different Rust pin with a
> browser group this repository does not need.
>
> Contract:
>
> - One commit, zero parents, on the branch `vendor/sandbox-toolchain`. Never merge it
>   into `main` and never open a pull request from it. The repository runs a
>   `secret-scan.yml` workflow on `pull_request`, and a pull request over roughly
>   780 MB of hex digests is a bad idea.
> - Root tree exactly `FETCH.md`, `LICENSES`, `MANIFEST.sha256`, `README.md`, `native`,
>   `rust`, `system`. Nothing else at the root.
> - Groups G1 to G8 as specified. No browser group. Add groups G9 to G13 only when the
>   task that triggered the rebuild names one of them, and never add a browser.
> - No file may reach 100 MiB. Split any archive at or above 90 MiB into `.part-NN`
>   pieces of exactly 94,371,840 bytes, zero-padded from `00`, and list both the parts
>   and the reassembled name in the manifest.
> - `MANIFEST.sha256` in `sha256sum -c` format, covering every blob, not listing
>   itself.
> - `FETCH.md` must be self-contained: an agent in the Arena agent sandbox reads it
>   and nothing else, and ends with every gate run.
> - Extract and build under `/tmp`. Pack with `xz` only, because the consuming
>   environment has no `zstd` and no `7z`.
> - The consuming environment, the Arena agent sandbox, is Debian 12, x86_64, glibc
>   2.36, 3,939 MB of RAM as `free` reports it and no
>   swap, 2 cores. It has git, curl, tar, xz, gzip, bzip2, unzip, gcc 12.2, make,
>   binutils, python3, node 22 and sha256sum. It has no cmake, pkg-config, patchelf,
>   file, clang, libclang, zstd, 7z, pnpm, bun, cargo, rustc, rustup or Xvfb. Ship all
>   of those.
> - `rust/Cargo.lock.sha256` must record the digest of all seven lockfiles as they are
>   in the repository at the commit you cite.
> - The two native archives must match the digests the `build.rs` scripts pin, byte for
>   byte.
>
> Cite the repository commit you built against in `README.md`.

## Verification when it comes back

Verify against the GitHub API rather than accepting the build report. The checks that
matter most, in order:

1. `git/trees/<sha>?recursive=1` returns `truncated: false`, and the root tree is
   exactly the seven entries above. Confirm `parents` is empty on the commit.
2. Recompute all seven `Cargo.lock` digests locally with `sha256sum` and compare them
   against `rust/Cargo.lock.sha256`. This is the cheapest decisive check.
3. Compare the `MANIFEST.sha256` digests for both `native/` archives against the pins
   in the two `build.rs` files. A match here means the offline build can link, and it
   needs no download to verify.
4. Reconcile the manifest arithmetic: total lines equals whole files plus parts plus
   reassembled archives, every blob is covered, and no line is malformed. Watch for
   paths containing spaces, which are legitimate in the cmake Help files.
5. Confirm no file is at or above 100 MiB.
6. Check `system/PKGS.txt` against the delta package list in the specification,
   especially `clang-14`, `libclang-14-dev`, `libclang-common-14-dev`, `libllvm14`,
   `libpulse-dev`, `libasound2-dev`, `libgtk-layer-shell-dev`, `xvfb`, `xauth`,
   `xserver-common`, `imagemagick`, `libmagickcore-6.q16-6` and `libmagickwand-6.q16-6`.
7. Confirm 0 pull requests and 0 workflow runs for the branch, and that `main` is
   unchanged.
8. Confirm the vendored crate directory count equals the union of crates.io packages
   plus git dependencies across the seven locks.

Then read the branch `README.md` gate table and check the numbers are internally
consistent. Do not treat a reported gate result as reproduced unless you ran it.

For a second delivery, add these checks.

- G9. Each media binary runs under `env -i` with a version banner. `ffmpeg -f lavfi -i
testsrc=duration=1:size=320x240:rate=30 -f gif -` writes bytes, which proves the encoder
  is present and not only the demuxer.
- G10. Each model digest matches `MODELS.txt`, and every delivered model file loads through
  the loader that will consume it, the sidecar for the ONNX bundles and whisper for the GGML
  weights. `MODELS.txt` is metadata and loads through nothing, so it is excluded from the load
  check. A model that loads is not a transcript that is correct, so record only loading.
- G12. `rustc --print target-list` proves nothing, because it lists targets without their
  standard libraries. Check `lib/rustlib/<target>/lib/libstd-*.rlib` exists for both
  `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`, run `cargo check --target` for each
  and confirm it reaches the code instead of failing on `core`, and match the component
  digests against `channel-rust-1.88.0.toml`.
- G13. `gitleaks detect --log-opts="<base>..<head>" --config <base>:gitleaks.toml` reports
  the same finding count as the last CI run on the same commit. A bare `--source .` scans a
  different commit set and cannot be compared.
- G11. `WebKitWebDriver` exists in the extracted sysroot at the recorded path, and
  `tauri-driver --version` runs.

Record the outcome in `engineering/sandbox-vendored-toolchain.md`, including anything
you found that the build report did not mention.

## Traps that have already cost time

- Cargo's SourceId for a git source replacement is the canonical URL **without** the
  `#<rev>` fragment. A `[source."git+https://github.com/owner/repo#rev"]` key does not
  match and the replacement silently does nothing.
- `block 0.1.6` is a genuine crates.io dependency of `cocoa`, so
  `/tmp/cargo-vendor/block-0.1.6` must exist even though `[patch.crates-io]` points the
  desktop crate at `patches/block-0.1.6`. The path patch still wins. Prove it with
  `cargo tree -i block`, which should show the `patches/` path.
- `cargo --config <path> clippy` does not work. Cargo does not forward the global
  `--config` flag to external subcommands. Put the replacement in
  `$CARGO_HOME/config.toml`.
- Pre-seeding only the extracted sherpa-onnx directory does not work. The `build.rs`
  wants the archive, so it can verify the digest. Pre-seed the archive and set
  `SHERPA_ONNX_ARCHIVE_DIR`.
- `DOCS_RS=1` skips linking entirely. It produces a crate that cannot run. Do not use
  it to make a gate pass.
- `whisper-rs-sys` ships `whisper.cpp` inside the crate. There is no separate
  `native/whisper.cpp/` group to build. This was an open question in the specification
  and the vendored directory settles it. The delivered branch also proves it, because its
  `Transcription lib tests` gate compiled the C++ with the tools tree's `cmake`.
- A GitHub release asset is not a delivery path. The URL answers 302 to
  `release-assets.githubusercontent.com`, which the Arena agent sandbox cannot reach. This is
  why `gitleaks` has to be vendored rather than downloaded at scan time, and why both
  `build.rs` scripts need pre-seeded archives.
- Never extract into the workspace. Everything under the workspace root is snapshotted
  against a size and file cap.
- Never commit a `.cargo/config.toml` with the vendored source replacement into this
  repository.
- Force-push with `--force-with-lease` if the branch has to be replaced. An orphan
  branch of this size is expensive to rewrite, so fix documentation defects in one
  pass rather than several.

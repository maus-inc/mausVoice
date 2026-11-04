# Sandbox vendor handoff prompt

Use this when the vendor payload has to be rebuilt. The build cannot happen inside a
network-restricted sandbox, because it needs `static.rust-lang.org`, `crates.io`,
Debian mirrors and GitHub Release assets. It has to be handed to an agent that has
unrestricted internet.

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
- A new `build.rs` that downloads from a host a sandbox cannot reach.

Do not rebuild for a TypeScript-only change, a docs change, or a migration.

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
> - Groups G1 to G8 as specified. No browser group.
> - No file may reach 100 MiB. Split any archive at or above 90 MiB into `.part-NN`
>   pieces of exactly 94,371,840 bytes, zero-padded from `00`, and list both the parts
>   and the reassembled name in the manifest.
> - `MANIFEST.sha256` in `sha256sum -c` format, covering every blob, not listing
>   itself.
> - `FETCH.md` must be self-contained: an agent in a restricted sandbox reads it and
>   nothing else, and ends with every gate run.
> - Extract and build under `/tmp`. Pack with `xz` only, because the consuming sandbox
>   has no `zstd` and no `7z`.
> - The consuming sandbox is Debian 12, x86_64, glibc 2.36, about 3.9 GB RAM with no
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
  and the vendored directory settles it.
- Never extract into the workspace. Everything under the workspace root is snapshotted
  against a size and file cap.
- Never commit a `.cargo/config.toml` with the vendored source replacement into this
  repository.
- Force-push with `--force-with-lease` if the branch has to be replaced. An orphan
  branch of this size is expensive to rewrite, so fix documentation defects in one
  pass rather than several.

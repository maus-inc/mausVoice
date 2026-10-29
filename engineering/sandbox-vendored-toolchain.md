# Sandboxed vendored toolchain

This file orients an agent working in a network-restricted sandbox. It records what
the vendor payload contains, what has been measured against this repository, and what
still cannot run. It does not duplicate the instructions.

Authoritative sources, in the order you should read them:

1. `FETCH.md` on the vendor branch. The step-by-step recipe. Eleven steps, with the
   exports, the reassembly loop and the gate table.
2. `README.md` on the vendor branch. Provenance, the verification table, size notes,
   and the things the consumer must know.
3. `engineering/rust-toolchain.md` in this repository. The offline cargo environment,
   the per-crate gate commands, the native payload env vars, and the mistake list.
4. `docs/sandbox-toolchain-vendor-spec.md` in this repository. The build
   specification, for when the payload has to be rebuilt.
5. `.agents/PREFLIGHT.md` in this repository. The pre-push checklist.

## The payload

Orphan branch `vendor/sandbox-toolchain` on `maus-inc/mausVoice`. Commit
`61fb32959d6ac6a36b0c6356069a767ee7725caa`, no parents, authored 2026-10-28, message
`vendor: sandbox toolchain payload (G1-G8)`. It is not merged into `main` and no pull
request exists for it. `main` is unaffected.

3870 blobs. The root tree is exactly `FETCH.md`, `LICENSES`, `MANIFEST.sha256`,
`README.md`, `native`, `rust`, `system`.

| Group       | Blobs | Logical bytes | What it is                                                                               |
| ----------- | ----- | ------------- | ---------------------------------------------------------------------------------------- |
| `system/`   | 3244  | 498,752,607   | Debian 12 development sysroot, the command line tools, and the build scripts             |
| `rust/`     | 10    | 259,104,704   | Rust 1.88.0 components, the channel toml, the vendored crate tree, the cargo config      |
| `native/`   | 4     | 30,713,132    | ONNX Runtime 1.23.2 and sherpa-onnx 1.13.5 archives                                      |
| `LICENSES/` | 609   | 9,652,209     | 605 Debian `copyright` files plus the ONNX Runtime, sherpa-onnx and whisper.cpp licences |
| root        | 3     | 538,810       | `README.md`, `FETCH.md`, `MANIFEST.sha256`                                               |

No single file reaches 100 MiB. Seven archives are split into `.part-NN` pieces at
exactly 94,371,840 bytes: the vendored crate tree in two parts and the sysroot in
five. `MANIFEST.sha256` carries 3871 lines, which is 3862 whole files plus the 7 parts
plus the 2 reassembled archives. It does not list itself.

Extracted size is about 5.3 GB. The sysroot is about 1.9 GB, the vendored crate tree
about 1.8 GB and the toolchain about 1.3 GB. Roughly 950 MB of the crate tree is five
versions of the `windows` crate, 0.51.1, 0.52.0, 0.54.0, 0.58.0 and 0.61.3, which are
dead weight on Linux but cannot be dropped without breaking `--locked` resolution for
the Windows installer workspace.

`system/tools/bin` ships `cmake` 3.25.1, `file` 1:5.44, `patchelf` 0.14.3, `pkgconf`
1.8.1 and a `pkg-config` symlink to `pkgconf`, with 83 library blobs covering 44
distinct library stems and `$ORIGIN/../lib` rpaths. `system/build/` ships the three
scripts that produced the closure. `system/PKGS.txt` lists 634 packages.

The vendored crate tree holds 1114 package directories, which is the 1113 crates.io
packages plus the one git dependency, `ferrous-focus`, that the union of the seven
`Cargo.lock` files requires.

## What has been measured

The branch `README.md` records these results. They were produced against this
repository at commit `61fb3295`.

| Gate                            | Result                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| Toolchain versions              | rustc 1.88.0, cargo 1.88.0, clippy 0.1.88, rustfmt 1.8.0-stable   |
| Toolchain component hashes      | 5 of 5 match `channel-rust-1.88.0.toml`                           |
| Sysroot symlinks                | 0 broken, 0 absolute                                              |
| Sysroot ELFs                    | 1559 checked, all X86-64                                          |
| pkg-config modules              | 37 of 37 resolve                                                  |
| Link smoke test                 | gcc linked 19 libraries successfully                              |
| Xvfb                            | started                                                           |
| Tools under `env -i`            | 4 of 4 run                                                        |
| Offline resolution              | `cargo metadata --locked` exit 0 for all seven manifests          |
| Path patches                    | `block`, `sherpa-onnx-sys` and `rdev` all resolve from `patches/` |
| Format                          | `cargo fmt --check` in six crates, 6 of 6 pass                    |
| Clippy                          | `apps/desktop/src-tauri`, 0 warnings in 6m 13s                    |
| Desktop lib tests               | 363 passed, 0 failed, 1 ignored                                   |
| Transcription lib tests         | 64 passed, 0 failed, 1 ignored                                    |
| pill_shared tests               | 242 passed, 0 failed                                              |
| GTK pill tests under `xvfb-run` | 42 passed, 0 failed                                               |
| Sidecar integration             | 7 passed, 0 failed, 4 ignored                                     |
| CI guard tests                  | `node --test scripts/ci/*.test.mjs`, 371 passed                   |
| Desktop TS unit                 | 3043 passed across 229 files                                      |
| voice-ai                        | 501 passed across 37 files                                        |
| agent                           | 24 passed                                                         |
| preview                         | 22 passed across 4 files                                          |
| Manifest                        | `sha256sum -c MANIFEST.sha256`, 3871 of 3871 OK                   |

## Independent verification

The payload was verified a second time, from outside the build, against the GitHub API
rather than against the builder's own report. Everything below was re-derived from the
branch contents.

- All seven `Cargo.lock` digests in `rust/Cargo.lock.sha256` were recomputed from the
  lockfiles in this repository. 7 of 7 match exactly, with no extra and no missing
  entry.
- The `MANIFEST.sha256` digests for `native/onnxruntime/onnxruntime-linux-x64-1.23.2.tgz`
  and `native/sherpa-onnx/sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2` match the
  pins in `packages/rust_transcription/build.rs` and
  `patches/sherpa-onnx-sys-1.13.5/build.rs` byte for byte. These are the two artifacts
  that fail without a vendor branch, because both `build.rs` scripts download from
  GitHub Releases.
- `rust/cargo-config.toml` carries three stanzas including the replacement for the
  `ferrous-focus` git dependency, with `directory = "/tmp/cargo-vendor"`.
- All 43 delta packages the specification demanded are present in `system/PKGS.txt`,
  including `clang-14`, `libclang-14-dev`, `libclang-common-14-dev`, `libllvm14`,
  `libpulse-dev`, `libasound2-dev`, `libgtk-layer-shell-dev`, `xvfb`, `xauth`,
  `xserver-common`, `imagemagick`, `libmagickcore-6.q16-6` and `libmagickwand-6.q16-6`.
- The manifest covers all 3870 blobs, has 0 malformed lines, and 23 paths legitimately
  contain spaces because they are cmake Help files. The `.part-00` reassembly loop only
  touches space-free paths, so the spaces are safe.
- 0 pull requests exist for the branch and 0 workflow runs were triggered. `main` is
  unchanged. A compare in both directions returns 404, which confirms unrelated
  histories.

Two cosmetic defects were found in the first cut of the branch. Both were fixed on
2026-10-29 by amending the orphan commit, which moved the tip from `691c51f9` to
`61fb3295`. Neither ever affected the payload.

1. The `README.md` heading sequence under "Things the consumer must know" ran
   `1,2,3,4,5,6,7,9,10,12,13,9,10`. Items 9 and 10 appeared twice and 8 and 11 never
   appeared. All 13 are now renumbered sequentially with no duplicates.
2. The packed size was stated three ways: 776 MB in the build report, 781 MB as the sum
   of the `README.md` table rows, and 798,761,772 bytes as the tree logical size. The
   table now gives measured values with an explicit packed total of 799 MB and an
   extracted total of 4.5 GB, states that MB means 10^6 bytes, and records the 737 MB
   codeload tarball, which is the number a consumer actually downloads.

The amendment is verifiable without trusting the report. Comparing the two trees blob by
blob shows exactly 2 changed files and nothing added or removed: `README.md` grew from
26,840 to 27,150 bytes, and `MANIFEST.sha256` kept its 495,011 byte size with a new
digest. The tree total moved from 798,761,462 to 798,761,772 bytes, a difference of
exactly the 310 bytes the README gained. The branch still has 0 parents and the same
commit message, so it remains a single orphan commit.

## Known limits

- `file --version` runs under `env -i`, but classifying a file needs
  `MAGIC=/tmp/tools/share/magic.mgc`, because Debian's `file` has a compiled-in path at
  `/usr/share/misc/magic.mgc` that does not exist in the sandbox. Nothing in this
  repository calls `file`, so this is a note rather than a blocker.
- The `--ignored` tests in
  `packages/rust_transcription/tests/sidecar_integration.rs` download models from
  `huggingface.co`, which is not on the allowlist. They cannot run. Report them as
  unrunnable with the reason. Do not report them as passed.
- `cargo test` needs `CARGO_BUILD_JOBS=1`. Parallel linking peaks above the memory a
  sandbox has and the linker dies with `signal 9`.
- `packages/rust_gtk_pill` opens a display, so it needs `xvfb-run -a`.
- `cmake` must be on `PATH` before any build of `packages/rust_transcription`.
- There is no browser group. This repository has no Playwright or WebDriver harness, so
  nothing was vendored for one, and about 260 MB was saved by not shipping it. Visual
  checking still has a surface inside the repository: `apps/preview` renders the real
  desktop components in a Vite app on port 5193 and needs no browser automation to run.

## Rebuild triggers

The payload has to be rebuilt when a `Cargo.lock` changes, when `rust-toolchain.toml`
moves off 1.88.0, when a `build.rs` pins a new ONNX Runtime or sherpa-onnx version, or
when a new native system library enters the GTK or Tauri link set. The procedure is in
`engineering/sandbox-vendor-handoff-prompt.md`.

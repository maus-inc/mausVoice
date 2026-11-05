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

Measure your own sandbox before you trust that list. The Arena agent sandbox on
2026-11-05 reached `static.rust-lang.org`, `sh.rustup.rs`, `index.crates.io`,
`huggingface.co`, `storage.googleapis.com`, `deb.debian.org` and GitHub Release
assets through `release-assets.githubusercontent.com`. That is why the G9 to G13
artifacts were fetched and their digests verified on 2026-11-05 rather than
described from a document. A sandbox that reaches those hosts does not need the
payload for them, and one that does not reaches the payload through this branch.

The trap that drives most of the original payload: `github.com` is reachable, but a
GitHub **Release asset download** is a 302 redirect to `objects.githubusercontent.com`,
which is not. Both of this repository's build-time native downloads are GitHub Release
assets, so they fail, and they fail late, after cargo has compiled several hundred
crates. This branch supplies those payloads and the environment variables that point
the build scripts at them.

## What is here

| Directory | What it holds | Packed | Extracted |
| --- | --- | --- | --- |
| `rust/toolchain/` | Rust 1.88.0: `rustc`, `rust-std`, `cargo`, `rustfmt`, `clippy`, plus `channel-rust-1.88.0.toml` | 127 MB | 602 MB |
| `rust/` (top level) | `cargo-vendor.tar.xz` parts (union of seven Cargo workspaces), `cargo-config.toml`, `Cargo.lock.sha256` | 132 MB | 1.73 GB |
| `system/` (top level) | `PKGS.txt` (634 packages) and `debian12-dev-sysroot.tar.xz` parts | 417 MB | 1.94 GB |
| `system/tools/` | `cmake`, `file`, `patchelf`, `pkgconf`, a complete 44-library closure, `TOOLS.txt` (88 rows), `share/cmake-3.25`, the G9/G13 binaries `ffmpeg`, `ffprobe`, `gifsicle` and `gitleaks` with `UIPIPE.txt`, `GITLEAKS.txt` and `GPLv3.txt`, the G16 to G22 groups (see below) with `TOOLS-G16-G22.txt` and `G22.txt`, the G23 to G27 groups with `TOOLS-G23-G27.txt`, and the valgrind debug-symbol tree under `debug/libc6-dbg` | 2.5 GB | 2.6 GB |
| `system/build/` | the three scripts that derived the sysroot links and the tools closure, with their own `README.md` | 15 KB | 15 KB |
| `native/onnxruntime/` | `onnxruntime-linux-x64-1.23.2.tgz` and `ONNXRUNTIME.txt` | 8.3 MB | 23 MB |
| `native/sherpa-onnx/` | `sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2` and `SHERPA.txt` | 22 MB | 138 MB |
| `models/` (G10) | `whisper/ggml-tiny.bin`, `whisper/ggml-base.bin` parts, `onnx/sense-voice/` and `MODELS.txt` | 463 MB | 463 MB |
| `drivers/` (G11) | `tauri-driver/tauri-driver` 2.0.6, `chromedriver-152.0.0/chromedriver` and `DRIVERS.txt` | 24 MB | 24 MB |
| `rust/targets/` (G12) | `x86_64-pc-windows-msvc` and `aarch64-apple-darwin` `rust-std-1.88.0.tar.xz` and `TARGETS.txt` | 47.5 MB | 245 MB |
| `LICENSES/` | `debian/<package>/copyright` for 780 packages, plus ONNX Runtime, sherpa-onnx and whisper.cpp texts | 15 MB | 15 MB |
| root | `README.md`, `FETCH.md`, `MANIFEST.sha256` | 2.9 MB | 2.9 MB |
| **total** | | **~3.8 GB** | **~8.3 GB** |

Packed is the exact sum of the files as they sit on the branch, measured with
`git ls-tree -r -l`. Extracted is after unpacking to `/tmp`. Both are MB (10^6 bytes).
The codeload tarball a consumer downloads is smaller than the packed sum, because git
compresses the tree.

Extracted total is roughly 8.3 GB, and it is a sum of per-directory figures rather than one
measurement. The parts that were measured here are `system/tools` at 2.6 GB (the fourth
delivery grew it from 1.37 GB), the models at 809 MB, the drivers at 24 MB, the two
cross-target standard libraries at 245 MB and the media tools at 167 MB. The sysroot is
about 1.9 GB, the vendored crate tree about 1.8 GB and the Rust toolchain about 1.3 GB, as
recorded in the first delivery. That fits in the ~19 GB a sandbox has, but only if nothing
is extracted into the workspace and the downloaded tarball is deleted after extraction.

## Groups G9 to G13

The first delivery carried the payload the shipped gates need. This branch now also
carries the five groups the spec calls G9 to G13, which cover stages the shipped
gates do not reach. Each is self-contained and optional, and each has its own
descriptor file with the upstream URL and the digest.

| Group | Directory | What it unblocks | Descriptor |
| --- | --- | --- | --- |
| G9 | `system/tools/bin/ffmpeg`, `ffprobe`, `gifsicle` | `ui-capture` GIF recording | `system/tools/UIPIPE.txt` |
| G10 | `models/` | the four `#[ignore]` sidecar tests with real models | `models/MODELS.txt` |
| G11 | `drivers/` | `pnpm --filter desktop test:webdriver` | `drivers/DRIVERS.txt` |
| G12 | `rust/targets/` | `cargo check --target` for the Windows and macOS cfgs | `rust/targets/TARGETS.txt` |
| G13 | `system/tools/bin/gitleaks` | the `secret-scan.yml` history scan | `system/tools/GITLEAKS.txt` |

Every new artifact is recorded in `MANIFEST.sha256`, so `sha256sum -c` covers it.
`tauri-driver` 2.0.6 and `gifsicle` 1.95 are built from source here, so their
digests are this branch's own output, not an upstream publication; the descriptor
files say so.

## Groups G16 to G22

The third delivery adds seven groups that cover debugging, native builds,
database work, OCR, shell and crypto tooling, cross compiles, and supply-chain
scanning. Each binary is checked under `env -i` with no `LD_LIBRARY_PATH` and
prints a version banner. The Debian packages they pulled are in
`system/tools/TOOLS-G16-G22.txt`, their release assets in `system/tools/G22.txt`,
and their copyright files under `LICENSES/debian/`.

| Group | Carries | Opens | Unpacked |
| --- | --- | --- | --- |
| G16 | `gdb` 13.1, `strace` 6.1, `ltrace` 0.7.3, `valgrind` 3.19.0 with its `libc6-dbg` build-id tree | a backtrace and a syscall trace for the native paths | 180 MB |
| G17 | `ninja` 1.11.1, `meson` 1.0.1, `autoconf` 2.71, `automake` 1.16.5, `libtoolize` 2.4.7, `m4` 1.4.19, `bison` 3.8.2, `flex` 2.6.4 | building a native dependency from source | 300 MB |
| G18 | `sqlite3` 3.40.1, `psql` 15.8, `mariadb` 10.11.6, `redis-cli` 7.0.15 | inspecting and repairing a database | 188 MB |
| G19 | `tesseract` 5.3.0 with `eng.traineddata` and `osd.traineddata` | the OCR round trip in the capture check | 111 MB |
| G20 | `shellcheck` 0.9.0, `shfmt` 3.6.0, `gpg`/`gpgv` 2.2.40, `git-lfs` 3.3.0, `zstd` 1.5.4, `brotli` 1.0.9, `7z` 22.01, `dig` 9.18.28, `tcpdump` 4.99.3 | shell lint, signing, archives, and a network probe that proves a claim | 243 MB |
| G21 | `mingw-w64` gcc 12, `aarch64-linux-gnu` gcc 12.2.0, `qemu-aarch64-static` 7.2.13 | cross build and emulate a second target | 1.7 GB |
| G22 | `trivy` 0.76.2, `syft` 1.20.0, `grype` 0.87.0, `osv-scanner` 1.9.2 | an SBOM and a vulnerability scan of a local build | 326 MB |

Five entries need a documented env var or flag, or a root copy, to run
relocatably. `FETCH.md` sets each one in its step.

| Binary | Needs | Why |
| --- | --- | --- |
| `gdb` | `--data-directory=<tools>/share/gdb` | its embedded Python imports the `gdb` module from the compiled-in `/usr/share/gdb/python` |
| `valgrind` | `VALGRIND_LIB=<tools>/libexec/valgrind`, and the traced program's glibc debug symbols at `/usr/lib/debug/.build-id` | `memcheck` and the other tools are separate programs under `libexec`, and it redirects glibc functions it cannot find without those symbols; the tree travels under `debug/libc6-dbg` |
| `meson` | a `python3` on `PATH` | it is a Python program; its own module tree travels in the payload, and the interpreter does not |
| `aarch64-linux-gnu-gcc` | `--sysroot=<tools>`, and `qemu-aarch64-static -L <tools>/usr/aarch64-linux-gnu` to run the result | it resolves its target libc from a fixed relative sysroot |
| the autotools | a root copy of `share/autoconf`, `share/aclocal`, `share/aclocal-1.16`, `share/automake-1.16` and `share/libtool` to `/usr/share`, and the scripts to `/usr/bin` | `autoconf`, `autom4te`, `autoheader`, `automake`, `aclocal` and `libtoolize` each read a compiled-in path, and `autoconf` execs `/usr/bin/autom4te`; no single env var redirects them all |

`trivy` is 168 MB, over the 90 MiB per-file cap, so it is split as
`trivy.part-00` and `trivy.part-01` and reassembled by `FETCH.md` Step 2.

Verified in the second agent sandbox on 2026-11-05, the one with broad egress,
Debian 13 and `apt-get`. A cross-compiled `x86_64-w64-mingw32` PE and an
`aarch64-linux-gnu` ELF both built, the ELF ran under `qemu-aarch64-static`, and
`tesseract` read `HELLO 42` from a generated PNG.

## Groups G23 to G27

The fourth delivery adds five groups that close the recorded capability gaps: the native
C/C++ build path, the runtime data a font- and timezone-aware program needs, a browser, the
language runtimes the document and analysis tools are written in, and the tools themselves.
Each binary is checked under `env -i` with no `LD_LIBRARY_PATH` and prints a version banner.
The Debian packages they pulled are in `system/tools/TOOLS-G23-G27.txt`, and their copyright
files under `LICENSES/debian/`.

| Group | Carries | Opens | Unpacked |
| --- | --- | --- | --- |
| G23 | `clang-14` and `clang++-14` 14.0.6, `llvm-config-14`, and GNU binutils 2.40 (`ld`, `as`, `ar`, `nm`, `objcopy`, `objdump`, `strip`, `ranlib`), with the `libLLVM-14`/`libclang-cpp` closure | compiling and linking a native C or C++ program without the base image's gcc | 330 MB |
| G24 | `fontconfig` 2.14.1, the DejaVu and Liberation fonts, `tzdata` 2026f, `locales` 2.36 with `localedef` and a pre-generated `en_US.UTF-8` | resolving a font by name, and correct `TZ=` and i18n formatting | 45 MB |
| G25 | `chromium` 156.0.8078.79 with its full shared-library closure | real browser rendering and headless screenshots for the WebDriver path | 620 MB |
| G26 | a headless OpenJDK 17 JRE, Ruby 3.1.2, CPython 3.11 with its stdlib, and Perl 5.36 | running PlantUML, Asciidoctor, binwalk and ExifTool, which are written in those languages | 290 MB |
| G27 | `pandoc` 2.17.1.1, `potrace` 1.16, `plantuml` 1.2020.02, `asciidoctor` 2.0.18, `exiftool` 12.57, `binwalk` 2.3.3, `lldb` 14.0.6, `mtr` 0.95, `hyperfine` 1.15.0, `heaptrack` 1.4.0, `perf` 6.1.190, `xdotool`, `scrot`, `xdpyinfo`, `xwininfo`, `xprop`, `xlsfonts`, `osslsigncode` 2.5 | document conversion, diagram and doc rendering, media metadata, binary inspection, debugging, network probes, benchmarking, direct X11 capture, and Windows signing on Linux | 320 MB |

Each of these runs from `system/tools/bin` with a self-locating wrapper where a wrapper is
needed, so no consumer step exports a variable for them:

- `clang-14`, `clang++-14`, `lldb` and the binutils carry an rpath of `$ORIGIN/../lib`.
- `chromium` is `system/tools/lib/chromium/chromium`; `bin/chromium` sets `LD_LIBRARY_PATH`
  to the closure in `lib/` and `lib/chromium/`.
- `plantuml` and `java` locate the JRE under `lib/jvm`; `asciidoctor` locates Ruby and its
  gem under `lib/ruby` and `share/rubygems-integration`; `python3.11`, `binwalk` and `lldb`
  locate the CPython stdlib and set `PYTHONDONTWRITEBYTECODE`; `exiftool` locates Perl and
  the `Image::ExifTool` tree under `share/perl5`.
- `fc-list`, `fc-match` and the other fontconfig binaries write a `fonts.conf` in a temp
  directory at run time that names `share/fonts`, and point `FONTCONFIG_FILE` at it.

`pandoc` (165 MB) and `libLLVM-14.so.1` (105 MB) are over the 90 MiB per-file cap, so each
is split as `.part-00` and `.part-01`. `chromium` (283 MB) and the JVM's `lib/modules`
(123 MB) are over GitHub's 100 MB hard limit, so they are split into four and two parts.
Every split file is reassembled by `FETCH.md` Step 2.

Verified on 2026-11-09 with the payload extracted to `/tmp`, every check under `env -i`
with only `system/tools/bin` on `PATH` and no `LD_LIBRARY_PATH`.

| Check | Command | Result |
| --- | --- | --- |
| Version banners | `env -i` on each G23 to G27 binary, with the documented flag | every one prints a version, or a usage banner where the tool has no `--version` |
| Native C++ build | `env -i clang++-14 f.cpp -o f && ./f` | links and prints `cpp ok` |
| Native C build | `env -i clang-14 f.c -o f && ./f` | links and prints `c ok` |
| Chromium DOM | `chromium --headless=new --no-sandbox --dump-dom file:///p.html` | prints `<h1>hi</h1>` |
| Chromium screenshot | `chromium --headless=new --no-sandbox --screenshot=s.png` | 745-byte PNG, 120x60 |
| PlantUML render | `plantuml -tpng -o /tmp d.puml` | 2388-byte PNG |
| Asciidoctor render | `asciidoctor -o d.html d.adoc` | HTML written |
| JVM run | `java H.java` | prints `java ok` |
| Font resolution | `fc-match -f '%{file}' 'DejaVu Sans'` | `<tools>/share/fonts/truetype/dejavu/DejaVuSans.ttf` |
| ExifTool | `exiftool -FileType s.png` | `PNG` |
| binwalk | `binwalk tiny.bin` | `PNG image, 120 x 60` |
| Split reassembly | `cat <name>.part-* \| sha256sum` vs `MANIFEST.sha256` | 9 of 9 MATCH |
| Manifest | `sha256sum -c MANIFEST.sha256` | 22466 of 22466 listed files OK, 0 failures |
| Broken symlinks | walk the tree for a link whose target is absent | 0 |
| Tree size | `git ls-tree -r -l` | 22476 blobs, about 3.80 GB logical |

## How to consume it

See `FETCH.md`. It is numbered steps, in order, and every step extracts to
`/tmp`. The short version:

1. Download the branch with `codeload` or a depth-1 clone.
2. Reassemble the split archives and `sha256sum -c MANIFEST.sha256`.
3. Install the Rust 1.88.0 toolchain to `/tmp/rust-tools`. Step 3b adds the
   cross-target standard libraries when a task needs them.
4. Extract the cargo vendor tree to `/tmp/cargo-vendor` and write
   `$CARGO_HOME/config.toml` from the shipped stanza.
5. Extract the sysroot to `/tmp/gtk-sysroot` and export the `PKG_CONFIG_*`,
   `CPATH`, `LIBRARY_PATH` and `LIBCLANG_PATH` variables.
6. Put `system/tools/bin` on `PATH`. This also puts `ffmpeg`, `ffprobe`,
   `gifsicle` and `gitleaks` on `PATH`.
7. Point the two native build scripts at the vendored payloads with
   `MAUSVOICE_ORT_DYLIB_PATH` and `SHERPA_ONNX_ARCHIVE_DIR`. Steps 7b to 7k add
   the models, drivers, UI-capture tools, debuggers, build tools, database
   clients, OCR, shell and crypto tools, cross compilers and scanners when a
   task needs them. Step 7l covers the fourth delivery: the native C/C++
   compiler, fonts and timezone data, a browser, the JVM/Ruby/Python/Perl
   runtimes, and the document, diagram, media, debugging, benchmarking and X11
   tools, all of which run from `system/tools/bin` with no extra export.
8. Enable pnpm through `corepack` and install with
   `CHROMEDRIVER_SKIP_DOWNLOAD=true`.
9. Run the gates.
10. Run the sanity checks.
11. Read the cautions.

## Verification performed before this branch was pushed

Every row is a command that was run in a clean `debian:12` container using only the
payloads on this branch and a checkout of `mausVoice` at the reference commit. These
rows cover the G1 to G8 delivery. The G9 to G13 rows are in the next section, and the
G16 to G22 rows follow those.

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

### Second delivery, G9 to G13

Measured on 2026-11-05 in the Arena agent sandbox, the same environment the
coverage gaps are recorded against. That sandbox reached every upstream this
delivery needs, so the artifacts were fetched and verified there rather than
built blind.

| Check | Command | Result |
| --- | --- | --- |
| rust-std digests | `sha256sum` both `rust-std-1.88.0.tar.xz` vs `xz_hash` in `channel-rust-1.88.0.toml` | 2 of 2 MATCH |
| rust-std contents | `tar tJf` for `lib/rustlib/<target>/lib/libstd-*.rlib` | present for both targets |
| Whisper digests | `sha256sum` `ggml-tiny.bin`, `ggml-base.bin` | match the upstream `main` blobs |
| SenseVoice digests | `sha256sum` `model.int8.onnx`, `tokens.txt` | match `SENSEVOICE_MODEL_SHA256` and `SENSEVOICE_TOKENS_SHA256` in `models.rs` |
| gitleaks digest | `sha256sum` the release tarball and the extracted binary | tarball `6e19050a…`, binary `1fac68c9…`; `gitleaks version` prints 8.18.0 |
| ffmpeg build | `env -i bin/ffmpeg -version`, then a 1 second `testsrc` encode to GIF | 7.0.2-static; encode produced 134299 bytes |
| gifsicle build | `./configure --disable-gifview --disable-gifdiff && make`, then `env -i` | 1.95; runs with an empty environment |
| tauri-driver build | `cargo install tauri-driver --version 2.0.6 --locked` on rustc 1.88.0 | built; 2.1.0 refused, it needs rustc 1.90 |
| chromedriver digest | `sha256sum` the zip and the extracted binary, then `--version` | 152.0.7977.42 |
| Split reassembly | `cat <name>.part-* \| sha256sum` vs `MANIFEST.sha256` | 4 of 4 MATCH |
| Manifest | `sha256sum -c MANIFEST.sha256` | every real file OK; the only 4 "FAILED open or read" lines are the split base names, whose reassembled digests the 4 MATCH rows above prove |
| Empty-environment run | `env -i` on each new binary | ffmpeg, ffprobe, gifsicle, gitleaks, tauri-driver and chromedriver all run |

`cargo check --locked --target x86_64-pc-windows-msvc` and the `aarch64-apple-darwin`
equivalent were not run, because the sandbox has no vendored crate tree for those
targets and `cargo check --target` needs the whole dependency graph. The G12 group
is shipped with its standard libraries verified present, and the check command is
recorded in `rust/targets/TARGETS.txt` for a consumer that has the crate tree.

### Third delivery, G16 to G22

Measured on 2026-11-05 in a second agent sandbox, Debian 13 with 4 vCPU, 15.9 GB RAM and
broad egress, not the Arena sandbox the second delivery used. The binary checks run from
a private copy of `system/tools`, under `env -i` with no `LD_LIBRARY_PATH`.

| Check | Command | Result |
| --- | --- | --- |
| Version banners | `env -i` on each of the 37 binaries, with the documented env var where one is needed | 37 of 37 print a version |
| gdb Python | `gdb --data-directory=<tools>/share/gdb --batch -ex 'python print("ok")'` | `ok` |
| valgrind tools | `VALGRIND_LIB=<tools>/libexec/valgrind valgrind --tool=memcheck /bin/true` with the libc6-dbg tree at `/usr/lib/debug` | 3.19.0, `0 errors from 0 contexts` |
| autotools round trip | `autoreconf -i` then `./configure` then `make` on a hello-world `configure.ac`, support trees at their compiled-in paths | `configure` and `Makefile.in` written, `./configure` exit 0, `make` links `./t` |
| meson modules | `meson --version` from the payload wrapper | 1.0.1, module tree found on `PYTHONPATH` |
| OCR round trip | `tesseract` on a generated PNG, `TESSDATA_PREFIX` set | reads `HELLO 42` |
| mingw cross build | `x86_64-w64-mingw32-gcc hi.c -o hi.exe` | PE, starts `M Z` |
| aarch64 cross build | `aarch64-linux-gnu-gcc --sysroot=<tools> hi.c -o hi` | ELF 64-bit, arm64 |
| emulated run | `qemu-aarch64-static -L <tools>/usr/aarch64-linux-gnu hi` | prints `hi` |
| trivy reassembly | `cat trivy.part-* \| sha256sum` vs `MANIFEST.sha256` | `6a972c69…` MATCH |
| Broken symlinks | walk the tree for a link whose target is absent | 0 |
| Manifest | `sha256sum -c MANIFEST.sha256` | 14437 of 14437 listed files OK (the manifest does not list itself); the only 5 "FAILED open or read" lines are the split base names, whose reassembled digests the rows above prove |
| Tree size | `git ls-tree -r -l` | 14438 blobs, about 2.63 GB logical |

The release-asset digests for G22 were checked against each project's own published
checksum manifest at build time, and are recorded in `system/tools/G22.txt`.

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

The largest extracted consumers are the sysroot at 1.94 GB, the cargo vendor tree at
1.73 GB and `system/tools` at 1.37 GB. The Rust toolchain unpacks to 602 MB. Together
with the payloads and a `target/` directory, plan on about 7 GB for the payload plus
several GB for build output.

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
message is `vendor: sandbox toolchain payload (G1-G8, G9-G13, G16-G27)`. The payload
mirrors the shape of the `better-Shape/app` branch `vendor/sandbox-toolchain` at commit
`7c4c8788b138294d1a9be31dbee79075df5e7f3d`, adapted for this repository's seven Cargo
workspaces, its Rust 1.88.0 pin, its WebdriverIO rather than Playwright setup, and its
two GitHub Release build-time downloads.

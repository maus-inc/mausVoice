# What the sandbox still lacks, beyond this repository's gates

Scope. This file describes one environment: the Arena agent sandbox that runs this repository's agent, measured on 2026-11-05 and 2026-11-09, with `vendor/sandbox-toolchain` at `3025c92b` fetched. It is not a property of the repository, of CI, or of your machine. On a host with normal internet, none of this applies: install the tool and move on. Probe before you repeat a line here, because a limit that does not hold where you run is not a limit.

Purpose. `engineering/sandbox-coverage-gaps.md` covers the gaps that block this repository's own gates (G9 to G15). This file covers everything else a development cycle needs, in this repository and in any other, so a builder on an unrestricted machine knows what to add to the payload and what can never be added.

## The environment as measured

Egress: `github.com`, `api.github.com`, `codeload.github.com`, `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org` answer. Every other host tried answers `000`, including `proxy.golang.org`, `repo1.maven.org`, `rubygems.org`, `nuget.org`, `packagist.org`, `crates.io`, `static.rust-lang.org`, `deb.debian.org`, `registry-1.docker.io`, `huggingface.co`, `nodejs.org`, `raw.githubusercontent.com` and `release-assets.githubusercontent.com`.

Machine: 2 vCPU, 3,939 MB of RAM, 21 GB free disk, no Docker daemon, no GPU, no sound card, no display. `apt-get` fails against every mirror, so the base image cannot grow.

Base image has: `git`, `gh`, node 22 with npm, pnpm and yarn, python 3.11 with pip, gcc and g++ 12, make, binutils, `curl`, `wget`, `jq`, `openssl`, `perl`, `tar`, `xz`, `zip`, `unzip`, `nc`, `socat`, `ssh`, `scp`, `ps`, `top`, `free`, `convert`, `ldd`.

The payload at `3025c92b` adds the Rust 1.88 toolchain and vendored crate tree, a Debian 12 development sysroot of 634 packages, the WebDriver drivers, the model set, the cross-target standard libraries, and `system/tools` with the G9, G13, G16 to G22 and G23 to G27 binaries. `system/tools` grew from 249 MB to 2.6 GB unpacked across the four deliveries.

## Tier 0: partly in the payload, partly a download

Only the `clang` PATH entry and the fontconfig wiring are free, because the files are already in the sysroot and only need a `FETCH.md` step or a symlink. The rest are not. `tzdata` and `locales` are absent from both the base image and the payload, so a builder adds them as downloads, about 15 MB combined. The `sqlite3` CLI is now delivered in group G18, so a builder gets it from the payload rather than adding it. The ImageMagick row is a note about syntax, not a missing artifact, because `convert` is already on the base image and in the sysroot.

| Capability                      | Where it already is                                                                                                                        | What is missing                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `clang`, `clang++`, `llvm-*` 14 | the sysroot's `/usr/bin` (`clang-14` and `libclang-14-dev` are in `system/PKGS.txt`)                                                       | the sysroot's `usr/bin` is not on `PATH`, so a `cc`-based build finds only the base image's gcc                         |
| TrueType fonts                  | the sysroot carries `fontconfig` and `fonts-dejavu-core`, and the host already has the DejaVu family at `/usr/share/fonts/truetype/dejavu` | the fontconfig binaries and cache are absent, so `fc-list` fails and a tool that resolves a font by name gets no answer |
| `convert` and `identify`        | ImageMagick is in the sysroot and `convert` is on the base image                                                                           | `magick` is absent, so ImageMagick 7 syntax fails                                                                       |
| Locale and timezone data        | `localedef` exists                                                                                                                         | `tzdata` and `locales` are not in the package set, so `TZ=` handling and any i18n formatting test are unreliable        |
| `sqlite3` shell                 | `libsqlite3-dev` is in the sysroot                                                                                                         | the CLI is not, so the app database cannot be opened or a migration inspected by hand                                   |

## Tier 1: missing tools this development cycle actually reaches for

Measured on the host, then checked against `system/PKGS.txt` so nothing here is already shipped. Sizes are estimates to be measured on the build host.

| Tool                                                                 | Why the cycle needs it                                                                                                                          | Size        | Priority |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| `gdb` with debug symbols                                             | the Rust and GTK paths die with `signal 9` and segfaults; without a debugger the only evidence is an exit code                                  | about 45 MB | high     |
| `strace`, `ltrace`                                                   | proves what a build script or a binary is actually doing when it fails silently, including the blocked host that started a download             | about 2 MB  | high     |
| `ninja`, `meson`, `autoconf`, `automake`, `libtool`, `bison`, `flex` | any native dependency built from source; the base image carries only `make` and `cmake`, so a `configure`-based or meson-based build cannot run | about 25 MB | high     |
| `sqlite3`                                                            | inspect and repair the app database, check a migration                                                                                          | about 2 MB  | high     |
| `postgresql-client`, `mariadb-client`, `redis-cli`                   | any feature that talks to a server, and any reproduction that needs a client                                                                    | about 25 MB | medium   |
| `tesseract` plus `eng.traineddata`                                   | the OCR round trip in the `ui-capture` validation, which G9 left out                                                                            | about 15 MB | medium   |
| `shellcheck`, `shfmt`                                                | `scripts/` and the hooks are shell, and nothing lints them locally                                                                              | about 6 MB  | medium   |
| `gpg`                                                                | sign a commit or a tag, verify a signature, check a release artifact                                                                            | about 12 MB | medium   |
| `git-lfs`                                                            | any binary asset that lands in the tree                                                                                                         | about 12 MB | medium   |
| `zstd`, `brotli`, `7z`                                               | unpack an artifact, inspect an AppImage, read a tarball the build produced                                                                      | about 4 MB  | medium   |
| `dig`, `tcpdump`, `mtr`                                              | prove a network claim instead of asserting one, which is the failure this repository already paid for                                           | about 5 MB  | medium   |
| `hyperfine`                                                          | compare two builds or two implementations when a change claims a speedup                                                                        | about 2 MB  | low      |
| `valgrind`, `perf`, `heaptrack`                                      | memory and CPU work on the native paths                                                                                                         | about 40 MB | low      |

Total for Tier 1: about 200 MB. Most of it now ships: `gdb`, `strace`, `ltrace`, `valgrind`, `ninja`, `meson`, `autoconf`, `automake`, `libtool`, `bison`, `flex`, `sqlite3`, `psql`, `mariadb`, `redis-cli`, `tesseract`, `shellcheck`, `shfmt`, `gpg`, `git-lfs`, `zstd`, `brotli`, `7z`, `dig` and `tcpdump` are in G16 to G22, and `mtr`, `perf`, `heaptrack` and `hyperfine` are in G27. The whole payload is about 8.3 GB unpacked.

## Tier 2: missing by domain, for any project

Except where a row is marked delivered, each row is absent from both the base image and the payload. Whether to vendor it depends on what the project does; the cost is what a builder would add.

### Languages and runtimes

| Missing                    | Blocks                                                                                             | Size                              |
| -------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| Go toolchain               | any Go service or CLI in a monorepo                                                                | about 70 MB                       |
| JDK 21                     | JVM services, Gradle, Maven, PlantUML, Spark                                                       | about 190 MB                      |
| .NET 8 SDK                 | C#, F#, MSBuild, NuGet restore                                                                     | about 220 MB                      |
| Ruby 3.3, PHP 8.3          | those ecosystems, and their package managers                                                       | about 100 MB                      |
| Node 24                    | `.nvmrc` asks for 24 and the image ships 22                                                        | about 30 MB                       |
| Deno, Bun                  | those runtimes                                                                                     | about 80 MB                       |
| Zig, Swift toolchain       | those build systems                                                                                | about 60 MB, Swift is much larger |
| R, Julia, Octave           | statistics and data work                                                                           | about 400 MB                      |
| Python C extension headers | `pip install` of any sdist that compiles, such as `psycopg2` without a wheel; `Python.h` is absent | about 10 MB                       |

### Containers and infrastructure

| Missing                                      | Blocks                                                                                     | Size                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------- |
| `docker` CLI, `buildx`, `compose`            | building or running a container definition; the daemon is absent anyway                    | about 90 MB           |
| `podman` rootless                            | the same, without a daemon; needs kernel and cgroup permissions the sandbox does not grant | about 120 MB          |
| `kubectl`, `helm`, `kind`, `k3d`, `k3s`      | any Kubernetes work                                                                        | about 200 MB          |
| `terraform`, `opentofu`, `ansible`, `pulumi` | infrastructure changes                                                                     | about 100 MB          |
| `aws`, `az`, `gcloud`                        | cloud work, and any credential flow                                                        | about 500 MB combined |

None of these are useful without network access to the control planes they talk to, so they are only worth vendoring for local simulation.

### Supply chain and security

| Missing                  | Blocks                                                 | Size         |
| ------------------------ | ------------------------------------------------------ | ------------ |
| `trivy`, `grype`, `syft` | vulnerability scan and SBOM of a local build           | about 130 MB |
| `osv-scanner`            | dependency advisories against the lockfiles            | about 30 MB  |
| `semgrep`                | static analysis beyond the TypeScript and Rust linters | about 40 MB  |
| `cosign`, `sigstore`     | sign and verify an artifact                            | about 40 MB  |
| `osslsigncode`           | sign a Windows installer on Linux                      | about 5 MB   |
| `hadolint`               | lint a Dockerfile                                      | about 10 MB  |
| `gitleaks`               | **already shipped**                                    | done         |

### Cross-platform builds

| Missing                              | Blocks                                                                                                       | Size         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------ |
| `mingw-w64`                          | building or linking a Windows binary on Linux                                                                | about 150 MB |
| `aarch64-linux-gnu` gcc, `qemu-user` | cross build and fast emulation of an arm64 Linux target                                                      | about 180 MB |
| Wine                                 | running the Windows binary this platform's tests would produce                                               | about 400 MB |
| macOS SDK, `codesign`, `notarytool`  | macOS builds and signing. Not vendorable: the SDK cannot be redistributed, so this stays a CI and human task | n/a          |

### Browsers and rendering

| Missing                          | Blocks                                                                                        | Size                |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| A Chromium build                 | real browser rendering, headless screenshots, anything the WebDriver suite drives             | about 180 MB packed |
| Playwright and its browser group | **declined by decision**, see `docs/decisions/no-playwright-harness.md`. Do not re-propose it | 933 MB              |
| Firefox, `geckodriver`           | the same paths in another engine                                                              | about 90 MB         |
| `xdotool`, `scrot`, `x11-utils`  | driving and capturing an Xvfb display directly, which is what a real GTK capture would need   | about 5 MB          |

The browser question is already settled in this repository: `apps/preview` on port 5193 is the visual surface, and the Chromium entry above is worth building only if a non-browser project needs real rendering.

### Documents, data and media

| Missing                                              | Blocks                                                                                  | Size                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| `pandoc`                                             | convert or render a document                                                            | about 30 MB                |
| `vale`, `markdownlint-cli2`, `asciidoctor`, `mdbook` | prose lint and doc builds beyond Prettier                                               | about 40 MB                |
| `plantuml`, `mermaid-cli`                            | diagram rendering, and `mermaid-cli` needs a Chromium                                   | about 25 MB plus a browser |
| LaTeX                                                | PDF output of a paper or a spec                                                         | about 500 MB               |
| `exiftool`, `potrace`                                | media metadata and vector tracing                                                       | about 20 MB                |
| `jupyter`, `duckdb`, `polars`                        | notebook and analytical work; `pip` reaches PyPI, so these install, but there is no GPU | about 500 MB               |

### Debugging and forensics, generic

| Missing              | Blocks                                        | Size         |
| -------------------- | --------------------------------------------- | ------------ |
| `lldb`               | Rust and C++ debugging with a modern UI       | about 100 MB |
| `binwalk`, `radare2` | inspecting an unknown binary artifact         | about 60 MB  |
| `qemu-system-*`      | booting anything                              | about 150 MB |
| `mitmproxy`          | inspecting an HTTP exchange when a call fails | about 20 MB  |

## What no payload can fix

These are properties of the sandbox, not missing software. Record them as limits rather than as gaps to close.

- Egress. Six hosts answer. Every other registry, mirror and API is unreachable, and the policy is set outside the sandbox.
- `apt-get`. No Debian mirror answers, so the base image cannot be extended in place. Only a payload can add a binary.
- macOS builds, signing and notarisation. The SDK is not redistributable.
- Windows code signing. Needs a secret and a certificate, neither of which belongs in a payload.
- GPU. No CUDA, no ROCm, no Metal.
- Audio input. No sound card, so microphone capture and the pill overlay against a live stream cannot run; use wav fixtures.
- Display. No X server until `xvfb-run` starts one, and then only a virtual one.
- RAM and CPU. 2 vCPU and 3,939 MB, which is why `CARGO_BUILD_JOBS=1` is required.
- Disk. 21 GB free, against an 8.3 GB payload and a multi-gigabyte Rust target tree.
- Credentials. No API keys, no cloud identity, no signing keys. CI supplies the ones this repository needs.

## Handoff for the builder

The payload keeps one orphan commit on `vendor/sandbox-toolchain`, so a further delivery folds into the same commit and moves the tip. Everything here follows the rules already in `docs/sandbox-toolchain-vendor-spec.md`:

1. No file over 90 MiB, and split with `.part-NN` at exactly 94,371,840 bytes to match the vendor contract, recording the reassembly in `FETCH.md`, as the sysroot, the crate tree, `ggml-base.bin`, the SenseVoice model, `chromium` and the JVM's `lib/modules` already do. GitHub rejects a push over 100 MiB, so 90 MiB leaves headroom.
2. Every artifact gets its upstream URL, its published sha256 and its licence under `LICENSES/`. `MANIFEST.sha256` carries one line per file plus one per reassembled archive.
3. Every binary is checked under `env -i` with no `LD_LIBRARY_PATH`, and prints a version banner. A binary that needs a library the payload does not carry is a payload defect. Some binaries need a documented env var to run relocatably, and each one is recorded in `FETCH.md` rather than treated as a defect: `gdb` needs `--data-directory=<tools>/share/gdb`, `valgrind` needs `VALGRIND_LIB=<tools>/libexec/valgrind`, `meson` needs a `python3` on `PATH`, and the cross compilers need `--sysroot=<tools>` for `aarch64-linux-gnu-gcc`.
4. Record what each group opens, in `README.md` on the branch and in `engineering/sandbox-coverage-gaps.md` here. A group that opens nothing must not ship.
5. Measure the packed and unpacked size on the build host and put the number in the table. Do not estimate.

Suggested grouping for the next delivery, continuing the numbering after G15. The `Estimate` column is the original budget. The `Measured` column records what the delivered group actually cost, in the second agent sandbox that built them (Debian 13 host, 4 vCPU, 15.9 GB RAM, broad egress).

| Group | Carries                                                                           | Opens                                                                  | Estimate     | Measured unpacked |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------ | ----------------- |
| G16   | `gdb`, `strace`, `ltrace`, `valgrind`                                             | a backtrace and a syscall trace for the native paths                   | about 60 MB  | 180 MB            |
| G17   | `ninja`, `meson`, `autoconf`, `automake`, `libtool`, `bison`, `flex`              | building a native dependency from source                               | about 25 MB  | 300 MB            |
| G18   | `sqlite3`, `psql`, `mariadb`, `redis-cli`                                         | inspecting and repairing a database                                    | about 25 MB  | 188 MB            |
| G19   | `tesseract` and `eng.traineddata`                                                 | the OCR round trip in the capture check                                | about 15 MB  | 111 MB            |
| G20   | `shellcheck`, `shfmt`, `gpg`, `git-lfs`, `zstd`, `brotli`, `7z`, `dig`, `tcpdump` | shell lint, signing, archives, and a network probe that proves a claim | about 40 MB  | 243 MB            |
| G21   | `mingw-w64`, `aarch64-linux-gnu` gcc, `qemu-user`                                 | cross build and emulate a second target                                | about 330 MB | 1.7 GB (tree)     |
| G22   | `trivy`, `syft`, `osv-scanner`                                                    | an SBOM and a vulnerability scan of a local build                      | about 190 MB | 326 MB            |

G21's first estimate of 180 MB was lower than its own two component estimates because it counted only the driver binaries, not the `lib/gcc`, `lib/gcc-cross` and target sysroot trees a cross compiler resolves by a fixed relative layout. The estimate column now reads about 330 MB and the measured column records the whole delivered group.

Tier 0 first: put the sysroot's `usr/bin` on `PATH`, point `FONTCONFIG_PATH` at the sysroot's fonts, and add `tzdata` and `locales` to the package set as downloads. The `sqlite3` CLI now ships in G18.

## Prompt to hand to the builder

> Update the `vendor/sandbox-toolchain` orphan branch on `maus-inc/mausVoice`. Read `engineering/sandbox-capability-gaps.md` in the repository first, then `docs/sandbox-toolchain-vendor-spec.md`. Ship the free Tier 0 wiring (the `clang` PATH entry and the fontconfig wiring) with no new downloads, then groups G16 to G20 from the handoff table, and G21 and G22 only if the size is acceptable to you. Add `tzdata` and `locales` as downloads when you build the groups. Keep one orphan commit and move its tip, keep every file under 90 MiB with `.part-NN` splitting at 94,371,840 bytes, record an upstream URL, a published sha256 and a licence for every artifact, verify each binary under `env -i`, and put the measured packed and unpacked size of each group in `README.md` on the branch. Then report the new commit SHA, the manifest line count, and what each group opens, so the repository's register can be updated to match.

> Delivered: G16 to G22 shipped 2026-11-05 at tip `82b2f983`; G23 to G27 shipped 2026-11-09 at tip `3025c92b`. Both are folded into the single orphan commit, so a consumer fetches every group from `3025c92b`.

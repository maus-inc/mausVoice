# What the vendored toolchain still does not cover

The orphan branch `vendor/sandbox-toolchain` makes most of this repository buildable inside the Arena agent sandbox: the six-host egress allowlist, 2 vCPU, 3.9 GB RAM (3,939 MB), no Docker daemon. Every number here was measured in that environment on 2026-11-05 and describes it alone, not the repository, not CI, and not your machine. An unrestricted host closes most of these gaps by installing the tool, so probe before you repeat a limit or file a gap. What follows records the parts of the development cycle the payload cannot cover, with the measurement for each one, so an agent stops guessing and a builder knows what to add.

The payload carries four deliveries. G1 to G8 are the mandatory set every gate needs. G9 to G13 are an optional second set, added 2026-11-05, that opens stages the mandatory set does not reach. G16 to G22 are an optional third set, added 2026-11-05, that adds debugging, native build tools, database clients, OCR, shell and crypto tooling, cross compilers and supply-chain scanners. G23 to G27 are an optional fourth set, added 2026-11-09, that adds the native C/C++ compiler and binutils, fontconfig with fonts plus `tzdata` and `locales`, Chromium, the JRE, Ruby, CPython and Perl, and the document, media-metadata and debugging tools. A gap below that a delivered group closes is marked, with the `FETCH.md` step that wires it up. Read the section as the register of what the payload does not carry, not as a list of stages that cannot run.

It answers two questions.

1. What can an agent do in that sandbox today.
2. Which missing requirement blocks the rest, and what exactly has to be vendored to unblock it.

Read `engineering/sandbox-vendored-toolchain.md` first for what the payload contains. This file is about this repository's gates; the tools an Arena agent sandbox lacks for a development cycle in any repository are in `engineering/sandbox-capability-gaps.md`. Read `docs/sandbox-toolchain-vendor-spec.md` when the payload has to be rebuilt. This file is the delta.

## Measured environment

Two agent sandboxes ran this repository's agent on 2026-11-05, and they are not the same machine. Every number in this file is a statement about one of them, so read the heading on each table before you repeat a limit.

- **Arena agent sandbox.** Six-host egress allowlist, 2 vCPU, 3,939 MB RAM, 21 GB disk, Debian 12 base image, no Docker daemon, no `apt-get` mirror. The `Hosts`, `Machine` and `Commands` tables below were measured here.
- **Second agent sandbox.** Broad egress, 4 vCPU, 15,990 MB RAM, 50 GB free disk, Debian 13 (trixie) base image, `apt-get` works. Re-measured on 2026-11-05 with `curl -m 8` and `command -v`. On this host `crates.io` answers 403 (its bot policy, not a missing route), and `static.rust-lang.org`, `sh.rustup.rs`, `huggingface.co`, `deb.debian.org`, `snapshot.debian.org`, `nodejs.org`, `dl.google.com` and the GitHub Release asset host all answer. A limit that says "no route" here is a property of the Arena sandbox, not of the network, so probe before you repeat one.

Both hosts ran the third delivery (G16 to G22). Its sizes were measured in the second sandbox, named per table below. The fourth delivery (G23 to G27) was built and measured on 2026-11-09.

### Hosts

`curl -m 8 -o /dev/null -w '%{http_code}' https://<host>/`, run from a clean shell. The results below are the Arena agent sandbox. The second sandbox reaches every host in this table and returns a non-000 code for all of them.

| Host                                                | Result   | Consequence here                                |
| --------------------------------------------------- | -------- | ----------------------------------------------- |
| `github.com`                                        | 200      | Git operations, `gh`, and raw file reads work   |
| `codeload.github.com`                               | 301      | The vendor payload downloads with `curl`        |
| `api.github.com`                                    | 200      | Checks, comments and releases are reachable     |
| `registry.npmjs.org`                                | 200      | pnpm and every npm package install              |
| `pypi.org`, `files.pythonhosted.org`                | 200, 404 | `req.txt` resolves                              |
| `crates.io`, `static.rust-lang.org`, `sh.rustup.rs` | no route | The payload supplies Rust and the crate tree    |
| `huggingface.co`                                    | no route | No model weights                                |
| `googlechromelabs.github.io`                        | no route | chromedriver cannot download                    |
| `objects.githubusercontent.com`                     | no route | GitHub release assets cannot download           |
| `cdn.playwright.dev`, `dl.google.com`               | no route | No Playwright browser, no Firebase emulator     |
| `storage.googleapis.com`                            | no route | No Chrome for Testing, no Google tooling        |
| `nodejs.org`                                        | no route | Node comes from the base image or npm           |
| `deb.debian.org`                                    | no route | `apt-get update` fails even though `sudo` works |
| `registry-1.docker.io`                              | no route | No container images                             |

A release asset such as `https://github.com/gitleaks/gitleaks/releases/download/v8.18.0/gitleaks_8.18.0_linux_x64.tar.gz` answers 302 to `release-assets.githubusercontent.com`, which has no route. That redirect is why `build.rs` downloads and the secret scan fail, and why "it is on github.com" is not a delivery path.

### Machine

| Resource                                   | Measured                  | Effect on the gates                                                                                               |
| ------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| CPU                                        | 2 vCPU                    | `cargo test` links one binary at a time, so `CARGO_BUILD_JOBS=1`                                                  |
| Memory                                     | 3,939 MB                  | Parallel linking peaks above it and the linker dies with signal 9                                                 |
| Disk                                       | 21 GB free                | The extracted payload is about 8.3 GB, the Rust target tree several more                                          |
| Node                                       | v22.22.3                  | Satisfies `engines`, is behind the `.nvmrc` pin of 24                                                             |
| npm                                        | 10.9.8                    | Installs pnpm@10.34.5 from the registry                                                                           |
| Python                                     | 3.11.2, pip 23.0.1        | `req.txt` resolves from PyPI                                                                                      |
| Rust, cargo, rustup                        | absent                    | Only the payload supplies them                                                                                    |
| cmake, pkg-config, patchelf, file, pkgconf | absent                    | The payload's `system/tools/bin` supplies them                                                                    |
| ffmpeg, ffprobe, gifsicle, tesseract       | absent in a bare checkout | The payload's `system/tools/bin` supplies all four: the media tools in the second delivery and `tesseract` in G19 |
| Xvfb                                       | absent                    | `packages/rust_gtk_pill` cannot run its tests without the payload                                                 |
| docker                                     | absent                    | `config/docker-compose.yml` cannot run                                                                            |

### Commands, run here

| Command                                           | Result            | Note                                                                                                    |
| ------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `npm i -g pnpm@10.34.5`                           | passed            | about 10 seconds                                                                                        |
| `pnpm install --frozen-lockfile`                  | failed            | chromedriver postinstall, see gap G15                                                                   |
| `pnpm install --frozen-lockfile --ignore-scripts` | passed            | 1398 packages, 29 seconds, 14 workspace projects; skips the G15 chromedriver step                       |
| `pnpm run check-types`                            | passed            | 9 turbo tasks, 49 seconds, no Rust needed                                                               |
| `pnpm run build`                                  | passed            | 11 turbo tasks, 68 seconds, vite plus astro, no Rust and no browser                                     |
| `cargo --version`                                 | command not found | needs the payload                                                                                       |
| `pnpm --filter desktop test:webdriver`            | cannot start      | needs a built app; G11 delivers tauri-driver and chromedriver, `WebKitWebDriver` comes from the sysroot |
| `ffmpeg -version`                                 | command not found | G9 delivers it in `system/tools/bin`; a bare checkout has no ffmpeg                                     |

## Coverage by stage

Status is what an agent gets here after following `FETCH.md`, not what CI gets on a hosted runner.

| Stage                                    | Status                            | What makes it work                                                                                                                                      |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency install                       | works when the recipe is followed | `CHROMEDRIVER_SKIP_DOWNLOAD=true` from `FETCH.md` step 8. A bare `pnpm install` fails. Gap G15                                                          |
| Formatting                               | works                             | `pnpm run format:check`, plus `cargo fmt` once the payload is in place                                                                                  |
| Lint, TypeScript and Rust                | works                             | `pnpm run lint`, `cargo clippy --locked` from the payload                                                                                               |
| Type check                               | works                             | `pnpm run check-types` measured at 9 tasks in 49 seconds                                                                                                |
| Unit tests, TypeScript                   | works                             | vitest per package                                                                                                                                      |
| Unit tests, Rust                         | works                             | linux targets only, `CARGO_BUILD_JOBS=1`                                                                                                                |
| Integration tests, sidecar               | works with the second delivery    | 7 pass, 4 are `#[ignore]` because they download models. G10 now delivers the whisper and SenseVoice weights, wired by `FETCH.md` step 7b                |
| App build, renderer                      | works                             | vite builds `apps/desktop`, `apps/preview`, and astro builds `apps/docs`                                                                                |
| Desktop app, `tauri dev`                 | works with the payload            | needs the sysroot and the two native archives                                                                                                           |
| Desktop bundle, `tauri build --bundles`  | blocked                           | Tauri downloads linuxdeploy and the AppImage runtime at bundle time. Gap G14                                                                            |
| WebDriver end to end                     | works with the second delivery    | G11 delivers `tauri-driver` 2.0.6 and `chromedriver`, wired by `FETCH.md` step 7c; `WebKitWebDriver` comes from the sysroot. Needs a built debug binary |
| Visual verification with the preview app | works                             | `pnpm --filter @maus-inc/preview dev` on port 5193                                                                                                      |
| Visual capture, `ui-capture`             | works with the fourth delivery    | G9 delivers `ffmpeg`, `ffprobe` and `gifsicle` (step 7d); G25 adds Chromium 156 in `system/tools/bin`, so a recording can run on Linux x86-64           |
| Secret scan over history                 | works with the second delivery    | G13 delivers `gitleaks` 8.18.0 in `system/tools/bin`, on `PATH` from step 6                                                                             |
| Secret scan over config only             | works                             | `pnpm run test:secret-scan` and `node --test scripts/ci/*.test.mjs`                                                                                     |
| Docs site build                          | works                             | astro, sharp arrives from npm                                                                                                                           |
| Release signing and notarisation         | impossible here                   | needs a macOS runner and Apple credentials                                                                                                              |
| Windows and macOS builds                 | impossible here                   | needs those runners, see accepted gaps                                                                                                                  |
| Dependency bumps                         | works from npm and PyPI           | crates.io needs a payload rebuild                                                                                                                       |

## Open gaps

Each gap names the stage it blocks, the measurement, what to vendor, and the substitute to use until it exists.

### G9: media tools for UI capture, delivered

Blocks the `ui-capture` workflow that `AGENTS.md` and `.agents/skills/ui-capture/SKILL.md` require for a change a user sees.

Measured before the second delivery. `ffmpeg`, `ffprobe`, `gifsicle` and `tesseract` were all absent. `system/PKGS.txt` carries `libavcodec59`, `libavformat`, `libsndfile1` and `imagemagick`, so the libraries were there and the executables were not.

Delivered. The second delivery ships `system/tools/bin/ffmpeg` 7.0.2-static, `ffprobe` 7.0.2-static and `gifsicle` 1.95, each run under `env -i`. `system/tools/UIPIPE.txt` records the upstream URL and the sha256 for each. They sit beside `cmake` and `file`, so `FETCH.md` step 6 puts them on `PATH`; step 7d checks them. `tesseract` and its `eng.traineddata` ship in G19, so the `ui-capture` validation step runs the OCR round-trip too.

Now delivered. The fourth delivery adds Chromium 156 in G25 at `system/tools/bin/chromium`, so the browser half of this gap is closed and a recording can run on Linux x86-64. The spec group G6 still declines to build a browser inside G9 itself; G25 is where it ships.

Substitute when no browser is available. Inspect `apps/preview` in both themes and write down the inspection rather than claiming a recording.

### G10: model weights, delivered

Blocks transcription development, the ignored sidecar tests, and any check of transcript quality. The delivered weights open the whisper and SenseVoice paths; the Parakeet and Canary tests stay blocked.

Measured before the second delivery. `huggingface.co` has no route in the Arena agent sandbox, and 19 references in the repository point at it. `packages/rust_transcription/tests/sidecar_integration.rs` marks four tests `#[ignore]` because they download models. The whisper weights are GGML files, `ggml-tiny.bin` upward, and the ONNX models are `parakeet-ctc-0.6b`, `parakeet-tdt-0.6b`, `canary-1b` and `sense-voice`.

Delivered. The second delivery ships the smallest useful set under `models/`, each with its URL, revision and sha256 in `models/MODELS.txt`.

- `models/whisper/ggml-tiny.bin` and `ggml-base.bin`, the upstream published blobs, `ggml-base.bin` split into two parts.
- `models/onnx/sense-voice/model.int8.onnx` and `tokens.txt`, at the immutable revision `355f4d4884d8afd08aef04b9007a8556d7b463b2`. Both digests equal `SENSEVOICE_MODEL_SHA256` and `SENSEVOICE_TOKENS_SHA256` in `models.rs`.

`FETCH.md` step 7b unpacks them under a private path and exports `RUST_TRANSCRIPTION_MODELS_DIR`. The whisper weights are runtime-overridable with `RUST_TRANSCRIPTION_MODEL_URL_<UPPERCASE_ID>`, so a local mirror is a valid route for `ggml-tiny` and `ggml-base`. The ONNX artifact sets have no such override.

Not delivered. The Parakeet CTC, Parakeet TDT and Canary 1B bundles, and the whisper small, medium, large-v3 and large-v3-turbo weights. Their digests are pinned in `models.rs`; extend the group behind a flag if a task needs them. Do not ship the 1.5 GB whisper large model in a default payload.

Substitute when the group is not wired. Unit tests that use synthesised audio buffers, and `#[ignore]` for anything that needs a real model. Say in the pull request that the model path was not exercised. Do not claim the transcription path works end to end when no model loaded. A model that loads is not a transcript that is correct, so record only loading.

### G11: WebDriver driver chain, delivered

Blocks the end to end UI gate, `pnpm --filter desktop test:webdriver`.

Measured before the second delivery. `apps/desktop/webdriver/wdio.conf.js` spawns `~/.cargo/bin/tauri-driver` on Linux and `chromedriver` on macOS. `tauri-driver` appears in no `Cargo.lock` in this repository, so the vendored crate tree cannot build it, and `cargo install tauri-driver` needs crates.io. `webkit2gtk-driver` is in `system/PKGS.txt`, and the binary sits inside `libwebkit2gtk-4.1-0` at `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebDriver`.

Delivered. The second delivery ships `drivers/tauri-driver/tauri-driver` 2.0.6 and `drivers/chromedriver-152.0.0/chromedriver` (152.0.7977.42), with `drivers/DRIVERS.txt` recording each digest. `FETCH.md` step 7c puts both on `PATH`. `tauri-driver` 2.1.0 is the current release and needs rustc 1.90, above this repository's 1.88.0 pin, so the payload carries 2.0.6.

Still needed. A built debug binary of the app, which no payload can supply, and `WebKitWebDriver` from the extracted sysroot. `FETCH.md` step 7c prints that path.

Substitute when the app is not built. `pnpm --filter @maus-inc/preview dev` and an inspection of the demo group in both themes, written down as an inspection rather than a recording.

### G12: no cross-target Rust standard library, delivered

Blocks local type checking of code behind `#[cfg(windows)]` and `#[cfg(target_os = "macos")]`.

Measured before the second delivery. `cargo clippy` on Linux compiles only the host cfg. `test-desktop-unit.yml` runs a `rust-windows-gated` job on `windows-2022` for the code that never compiles here. The payload carried the host toolchain only, so `cargo check --target x86_64-pc-windows-msvc` failed on the missing standard library before it reached the code.

Delivered. The second delivery ships `rust/targets/x86_64-pc-windows-msvc/rust-std-1.88.0.tar.xz` and the `aarch64-apple-darwin` equivalent, both digests equal to the `xz_hash` values in `channel-rust-1.88.0.toml`. `rust/targets/TARGETS.txt` records them. `FETCH.md` step 3b unpacks both into the toolchain prefix. `cargo check` does not link, so no Windows SDK and no macOS SDK is needed.

Caveat. The vendored crate tree ships, but it is resolved for the host triple. Run `cargo check --target <triple>` with the shipped vendor config, record the result for each target in `TARGETS.txt`, and do not assume the host-resolved tree covers a target-specific dependency. `rustc --print target-list` proves nothing on its own, because it lists targets without their standard libraries. Confirm `lib/rustlib/<target>/lib/libstd-*.rlib` exists for both targets.

Substitute when the crate tree is not available. Say that platform gated code was checked by CI for that platform, and name the job.

### G13: secret scanning binary, delivered

Blocks the history scan in `.github/workflows/secret-scan.yml`, which pins gitleaks 8.18.0 and downloads it from a GitHub release.

Measured before the second delivery. The release asset answers 302 to `release-assets.githubusercontent.com`, which has no route. `pnpm run test:secret-scan` and `node --test scripts/ci/*.test.mjs` still pass, because they test the scan configuration rather than run a scan.

Delivered. The second delivery ships `system/tools/bin/gitleaks` 8.18.0 with its sha256 in `MANIFEST.sha256` and its provenance in `system/tools/GITLEAKS.txt`. `FETCH.md` step 6 puts it on `PATH`. The binary reports its version with `gitleaks version`, not `--version`.

Run it the way CI runs it. `gitleaks detect --log-opts="<base-sha>..<head-sha>" --config <base-sha>:gitleaks.toml`. A bare `--source .` scans a different commit set and cannot be compared with CI.

Substitute when the group is not wired. Run the configuration tests, and state in the pull request that the history scan runs in CI only.

### G14: no packaging toolchain

Blocks `tauri build --bundles`, and therefore any local check of an installer. `apps/desktop/src-tauri/tauri.conf.json` sets `bundle.targets` to `all`.

Measured. Tauri resolves `linuxdeploy` and the AppImage runtime by downloading them from GitHub releases at bundle time, and those redirect to a blocked host. `dpkg-deb` is present, so the deb target has a chance, and a full release build also needs several GB of `target/`, which the workspace snapshot cap forbids.

What to vendor, if anyone needs local bundling. A `system/bundle/` group with `linuxdeploy-x86_64.AppImage`, the AppImage runtime, and a documented `TAURI_BUNDLER_TOOLS` style override. The spec records the decision to defer this, D-5. Keep it deferred until a release task lands in the sandbox.

Substitute today. Treat bundling as CI-only, and say so in the pull request.

### G15: the install step fails on chromedriver

Blocks dependency install, and therefore every gate that starts with a clean checkout.

Measured. A bare `pnpm install --frozen-lockfile` prints `Failed` at `chromedriver install`, then `ELIFECYCLE Command failed with exit code 1`. The payload already documents the fix in `FETCH.md` step 8, and this repository's own preflight and `AGENTS.md` did not carry it until now, so an agent that started from the repository docs hit the failure and an agent that started from `FETCH.md` did not. The install script makes a request to `https://googlechromelabs.github.io/chrome-for-testing/152.0.7977.42.json`, which fails with `ECONNRESET` because that host has no route. `chromedriver@152.0.0` is a devDependency of `apps/desktop`, and both `package.json` and `pnpm-workspace.yaml` list it in `onlyBuiltDependencies`, so its install script runs on every full install. No CI job runs the WebDriver suite, so the binary itself is only needed by `pnpm --filter desktop test:webdriver`.

What to do, in preference order.

1. Repeat `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` in `.agents/PREFLIGHT.md` and `AGENTS.md`, which now do carry it. The install script exits 0 when it sees the flag. Nothing has to be built.
2. Ship a platform-matched chromedriver plus its URL and sha256, and set `CHROMEDRIVER_FILEPATH`. Take the Linux archive for `test:webdriver` under Xvfb here, and only add a macOS archive if someone intends to run that path on a Mac.
3. Ship `drivers/tauri-driver` as a prebuilt binary. See G11.

Substitute today. `pnpm install --frozen-lockfile --ignore-scripts`. Name the flag in the pull request, because it also skips the other `onlyBuiltDependencies` scripts. Measured as harmless here, since esbuild and sharp resolve their platform binaries from npm optional dependencies, and `bcrypt` and `re2` are not in the lockfile.

### G16 to G22: the third delivery, delivered

The third delivery was built on 2026-11-05 in the second agent sandbox, the one with broad egress, Debian 13 and `apt-get`. It closes seven of the entries in `engineering/sandbox-capability-gaps.md` and shipped at tip `82b2f983` of the same orphan branch; the fourth delivery later moved that tip to `3025c92b`. Sizes below are measured unpacked, not estimated.

| Group | Carries                                                                                                                                            | Opens                                                                     | Unpacked |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| G16   | `gdb` 13.1, `strace` 6.1, `ltrace` 0.7.3, `valgrind` 3.19.0 with its `libc6-dbg` build-id tree                                                     | a backtrace and a syscall trace for the native paths                      | 180 MB   |
| G17   | `ninja` 1.11.1, `meson` 1.0.1, `autoconf` 2.71, `automake` 1.16.5, `libtoolize` 2.4.7, `m4` 1.4.19, `bison` 3.8.2, `flex` 2.6.4                    | building a native dependency from source, end to end through `autoreconf` | 300 MB   |
| G18   | `sqlite3` 3.40.1, `psql` 15.8, `mariadb` 10.11.6, `redis-cli` 7.0.15                                                                               | inspecting and repairing a database                                       | 188 MB   |
| G19   | `tesseract` 5.3.0 with `eng.traineddata` and `osd.traineddata`                                                                                     | the OCR round trip in the capture check                                   | 111 MB   |
| G20   | `shellcheck` 0.9.0, `shfmt` 3.6.0, `gpg`/`gpgv` 2.2.40, `git-lfs` 3.3.0, `zstd` 1.5.4, `brotli` 1.0.9, `7z` 22.01, `dig` 9.18.28, `tcpdump` 4.99.3 | shell lint, signing, archives, and a network probe that proves a claim    | 243 MB   |
| G21   | `mingw-w64` gcc 12, `aarch64-linux-gnu` gcc 12.2.0, `qemu-aarch64-static` 7.2.13                                                                   | cross build and emulate a second target                                   | 1.7 GB   |
| G22   | `trivy` 0.76.2, `syft` 1.20.0, `grype` 0.87.0, `osv-scanner` 1.9.2                                                                                 | an SBOM and a vulnerability scan of a local build                         | 326 MB   |

G21 is large because a cross compiler is not a binary. It resolves `cc1` from `lib/gcc/<triple>/<version>`, the target headers and libraries from a fixed relative sysroot, and its binutils from `<triple>/bin`, which are symlinks into `bin/`. A payload that ships only the driver fails with `cannot execute 'cc1'`, then `stdio.h: No such file or directory`, then a missing `Scrt1.o`. The delivered layout preserves those relative paths under `system/tools` and ships the cross libc (`libc6-dev-arm64-cross`, `libc6-arm64-cross`, `linux-libc-dev-arm64-cross`).

Six of the new tools need a documented env var, flag or root copy to run relocatably, and each is recorded in `FETCH.md` step 7e to 7k:

- `gdb` needs `--data-directory=<tools>/share/gdb`, because its embedded Python looks for the `gdb` module under the compiled-in `/usr/share/gdb/python`.
- `valgrind` needs `VALGRIND_LIB=<tools>/libexec/valgrind`, because `memcheck` and the other tools are separate programs under `libexec`, and it needs the traced program's glibc debug symbols at `/usr/lib/debug/.build-id`, shipped under `system/tools/debug/libc6-dbg`.
- `meson` is a Python program and needs a `python3` on `PATH`, with its module tree on `PYTHONPATH`.
- `aarch64-linux-gnu-gcc` needs `--sysroot=<tools>` to find its target libc, and `qemu-aarch64-static -L <tools>/usr/aarch64-linux-gnu` to run the result.
- the autotools need a root copy of their `share` trees to `/usr/share` and the scripts to `/usr/bin`, because `autoconf`, `autom4te`, `automake`, `aclocal` and `libtoolize` each read a compiled-in path and no single env var redirects them all.

Verified in the second sandbox on 2026-11-05: 37 of 37 binaries print a version under `env -i`, the OCR round trip reads `HELLO 42`, both cross compilers produce a runnable binary, and `sha256sum -c` passed on all 14437 listed files of that delivery. G22 is verifiable in the second sandbox because it reaches the GitHub Release asset host; on the Arena sandbox, where it does not, G22 would have to be built elsewhere or left out.

### G23 to G27: the fourth delivery, delivered

The fourth delivery was built on 2026-11-09. It adds the native C/C++ compiler and binutils, the runtime data a font- and timezone-aware program needs, a browser, the language runtimes the document and analysis tools are written in, and the tools themselves, and ships at tip `3025c92b` of the same orphan branch. Sizes below are measured unpacked.

| Group | Carries                                                                                                                                                                                                                                                                                 | Opens                                                                                                                                                                        | Unpacked |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| G23   | `clang-14` and `clang++-14` 14.0.6, `llvm-config-14`, and GNU binutils 2.40 (`ld`, `as`, `ar`, `nm`, `objcopy`, `objdump`, `strip`, `ranlib`), with the `libLLVM-14`/`libclang-cpp` closure                                                                                             | compiling and linking a native C or C++ program without the base image's gcc                                                                                                 | 330 MB   |
| G24   | `fontconfig` 2.14.1, the DejaVu and Liberation fonts, `tzdata` 2026f, `locales` 2.36 with `localedef` and a pre-generated `en_US.UTF-8`                                                                                                                                                 | resolving a font by name, and correct `TZ=` and i18n formatting                                                                                                              | 45 MB    |
| G25   | `chromium` 156.0.8078.79 with its full shared-library closure                                                                                                                                                                                                                           | real browser rendering and headless screenshots for the WebDriver path                                                                                                       | 620 MB   |
| G26   | a headless OpenJDK 17 JRE, Ruby 3.1.2, CPython 3.11 with its stdlib, and Perl 5.36                                                                                                                                                                                                      | running PlantUML, Asciidoctor, binwalk and ExifTool, which are written in those languages                                                                                    | 290 MB   |
| G27   | `pandoc` 2.17.1.1, `potrace` 1.16, `plantuml` 1.2020.02, `asciidoctor` 2.0.18, `exiftool` 12.57, `binwalk` 2.3.3, `lldb` 14.0.6, `mtr` 0.95, `hyperfine` 1.15.0, `heaptrack` 1.4.0, `perf` 6.1.190, `xdotool`, `scrot`, `xdpyinfo`, `xwininfo`, `xprop`, `xlsfonts`, `osslsigncode` 2.5 | document conversion, diagram and doc rendering, media metadata, binary inspection, debugging, network probes, benchmarking, direct X11 capture, and Windows signing on Linux | 320 MB   |

Every binary runs from `system/tools/bin` with a self-locating wrapper where one is needed, so a consumer exports no variable for them. `chromium` (283 MB) and the JVM's `lib/modules` (123 MB) are over GitHub's 100 MB hard limit, so they are split into `.part-*` pieces that `FETCH.md` Step 2 reassembles. Verified on 2026-11-09 with the payload extracted to `/tmp`, under `env -i`: every G23 to G27 binary prints a version or a usage banner, `clang++-14` compiles and links a C++ program, `chromium --dump-dom` renders HTML and `--screenshot` writes a PNG, `plantuml` renders a PNG, `asciidoctor` renders HTML, `java` runs a source file, `fc-match` resolves DejaVu Sans from the payload, and `sha256sum -c` passes on all 22466 manifest lines. This closes G14 for the packaging-tool question only in part: `osslsigncode` covers Windows signing, but no `dmg` or `msi` packer ships.

## Accepted gaps

No payload closes these. Name them in the pull request rather than working around them.

- Provider API keys. The `GROQ_API_KEY` integration tests in `apps/desktop` need a key that the Arena agent sandbox does not carry. CI supplies one through `secrets.GROQ_API_KEY`, and a developer machine may have one in `.env.local`, so check `printenv GROQ_API_KEY` before you call the test impossible. Do not invent a key and do not skip silently.
- Audio devices. Microphone capture, the pill overlay against a real stream, and anything that needs a sound card. Use wav fixtures from `scripts/transcripts/`.
- macOS and Windows runners. Signing, notarisation, `dmg` and `msi` output, and the Cocoa and Win32 code paths.
- Containers. `config/docker-compose.yml` and the Ollama path need Docker Hub and a running daemon.
- Debian mirrors. `apt-get update` fails, so no package can be added at build time.

## What the payload already covers

So the register is not read as a list of failures.

| Group               | Covers                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rust/toolchain`    | Rust 1.88.0, cargo, clippy 0.1.88, rustfmt                                                                                                                             |
| `rust/cargo-vendor` | 1114 crate directories, the union of the seven lockfiles                                                                                                               |
| `rust/targets`      | G12, the `x86_64-pc-windows-msvc` and `aarch64-apple-darwin` standard libraries, for `cargo check --target`                                                            |
| `system/`           | Debian 12 development sysroot, `cmake`, `file`, `patchelf`, `pkgconf`, Xvfb, ImageMagick, and the GTK, WebKit, ALSA and Pulse link set                                 |
| `system/tools/bin`  | G9 `ffmpeg`, `ffprobe` and `gifsicle` for `ui-capture`, G13 `gitleaks` 8.18.0, the third delivery's G16 to G22 binaries, and the fourth delivery's G23 to G27 binaries |
| `system/tools/`     | G21's `lib/gcc`, `lib/gcc-cross` and target sysroot trees, and G16's `libexec/valgrind` and `share/gdb`                                                                |
| `native/`           | ONNX Runtime 1.23.2 and sherpa-onnx 1.13.5 linux x64 archives                                                                                                          |
| `models/`           | G10, the whisper `ggml-tiny` and `ggml-base` weights and the SenseVoice ONNX bundle                                                                                    |
| `drivers/`          | G11, `tauri-driver` 2.0.6 and `chromedriver` 152.0.7977.42                                                                                                             |
| `LICENSES/`         | 780 Debian `copyright` files plus the ONNX Runtime, sherpa-onnx and whisper.cpp licences, so a redistributed payload stays auditable                                   |

## Order of work

Cheapest unblock first. Each line names the stage it opens. The second delivery is shipped, so the lines that named it are done and the table records what each one opened.

| Step | Group                                                                              | Opens                                                                                                        | State                                              |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 1    | `CHROMEDRIVER_SKIP_DOWNLOAD` in `FETCH.md`, `.agents/PREFLIGHT.md` and `AGENTS.md` | a clean install                                                                                              | documented                                         |
| 2    | G13 gitleaks, 7 MB                                                                 | the history scan locally                                                                                     | shipped                                            |
| 3    | G9 ffmpeg, ffprobe and gifsicle, 160 MB                                            | `ui-capture` encoding and GIF assembly                                                                       | shipped                                            |
| 4    | G12 cross-target standard libraries, 47.5 MB packed                                | local type checks of platform gated code                                                                     | shipped                                            |
| 5    | G11 tauri-driver 2.0.6 and chromedriver, 24 MB                                     | the end to end gate on Linux, once the app is built                                                          | shipped                                            |
| 6    | G10 model weights, 463 MB                                                          | transcription behaviour with real models                                                                     | shipped                                            |
| 7    | G14 packaging                                                                      | local installer checks                                                                                       | deferred until a release task lands in the sandbox |
| 8    | G16 to G22, 376 MB packed / 1.2 GB unpacked                                        | debugging, native builds, databases, OCR, shell and crypto tooling, cross compiles, SBOM and scanning        | shipped                                            |
| 9    | G23 to G27, 1.17 GB packed / 1.6 GB unpacked                                       | the native C/C++ build path, font and timezone data, a browser, the language runtimes and the document tools | shipped                                            |

## Rebuild triggers

The payload needs a rebuild when a `Cargo.lock` changes, when `rust-toolchain.toml` moves off 1.88.0, when `packages/rust_transcription/build.rs` or `patches/sherpa-onnx-sys-1.13.5/build.rs` pins a new archive, when `apps/desktop/package.json` moves the `chromedriver` major, or when a new native library joins the GTK or Tauri link set.

The build procedure is `engineering/sandbox-vendor-handoff-prompt.md`, and the build specification is `docs/sandbox-toolchain-vendor-spec.md`.

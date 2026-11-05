# What the vendored toolchain still does not cover

The orphan branch `vendor/sandbox-toolchain` makes most of this repository buildable in a network-restricted sandbox. This file records the parts of the development cycle it still cannot cover, with the measurement for each one, so an agent stops guessing and a builder knows what to add.

It answers two questions.

1. What can an agent do in this sandbox today.
2. Which missing requirement blocks the rest, and what exactly has to be vendored to unblock it.

Read `engineering/sandbox-vendored-toolchain.md` first for what the payload contains. Read `docs/sandbox-toolchain-vendor-spec.md` when the payload has to be rebuilt. This file is the delta.

## Measured environment

Measured on 2026-11-05 in the Arena sandbox that runs the agent for this repository. Re-measure before you rely on it, because the numbers move.

### Hosts

`curl -m 8 -o /dev/null -w '%{http_code}' https://<host>/`, run from a clean shell.

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

| Resource                                   | Measured           | Effect on the gates                                                      |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------------------ |
| CPU                                        | 2 vCPU             | `cargo test` links one binary at a time, so `CARGO_BUILD_JOBS=1`         |
| Memory                                     | 3 GB               | Parallel linking peaks above it and the linker dies with signal 9        |
| Disk                                       | 21 GB free         | The extracted payload is about 5.3 GB, the Rust target tree several more |
| Node                                       | v22.22.3           | Satisfies `engines`, is behind the `.nvmrc` pin of 24                    |
| npm                                        | 10.9.8             | Installs pnpm@10.34.5 from the registry                                  |
| Python                                     | 3.11.2, pip 23.0.1 | `req.txt` resolves from PyPI                                             |
| Rust, cargo, rustup                        | absent             | Only the payload supplies them                                           |
| cmake, pkg-config, patchelf, file, pkgconf | absent             | The payload's `system/tools/bin` supplies them                           |
| ffmpeg, ffprobe, gifsicle, tesseract       | absent             | `ui-capture` cannot run                                                  |
| Xvfb                                       | absent             | `packages/rust_gtk_pill` cannot run its tests without the payload        |
| docker                                     | absent             | `config/docker-compose.yml` cannot run                                   |

### Commands, run here

| Command                                                          | Result            | Note                                                                                                      |
| ---------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `npm i -g pnpm@10.34.5`                                          | passed            | about 10 seconds                                                                                          |
| `pnpm install --frozen-lockfile`                                 | failed            | chromedriver postinstall, see gap G9                                                                      |
| `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` | passed            | the recipe in `FETCH.md` step 8 plus `--ignore-scripts`, 1398 packages, 29 seconds, 14 workspace projects |
| `pnpm run check-types`                                           | passed            | 9 turbo tasks, 49 seconds, no Rust needed                                                                 |
| `pnpm run build`                                                 | passed            | 11 turbo tasks, 68 seconds, vite plus astro, no Rust and no browser                                       |
| `cargo --version`                                                | command not found | needs the payload                                                                                         |
| `pnpm --filter desktop test:webdriver`                           | cannot start      | needs tauri-driver, WebKitWebDriver, and a built app                                                      |
| `ffmpeg -version`                                                | command not found | blocks `ui-capture`                                                                                       |

## Coverage by stage

Status is what an agent gets here after following `FETCH.md`, not what CI gets on a hosted runner.

| Stage                                    | Status                            | What makes it work                                                                                   |
| ---------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Dependency install                       | works when the recipe is followed | `CHROMEDRIVER_SKIP_DOWNLOAD=true` from `FETCH.md` step 8. A bare `pnpm install` fails. Gap G9        |
| Formatting                               | works                             | `pnpm run format:check`, plus `cargo fmt` once the payload is in place                               |
| Lint, TypeScript and Rust                | works                             | `pnpm run lint`, `cargo clippy --locked` from the payload                                            |
| Type check                               | works                             | `pnpm run check-types` measured at 9 tasks in 49 seconds                                             |
| Unit tests, TypeScript                   | works                             | vitest per package                                                                                   |
| Unit tests, Rust                         | works                             | linux targets only, `CARGO_BUILD_JOBS=1`                                                             |
| Integration tests, sidecar               | partial                           | 7 pass, 4 are `#[ignore]` because they download models. Gap G10                                      |
| App build, renderer                      | works                             | vite builds `apps/desktop`, `apps/preview`, and astro builds `apps/docs`                             |
| Desktop app, `tauri dev`                 | works with the payload            | needs the sysroot and the two native archives                                                        |
| Desktop bundle, `tauri build --bundles`  | blocked                           | Tauri downloads linuxdeploy and the AppImage runtime at bundle time. Gap G13                         |
| WebDriver end to end                     | blocked                           | tauri-driver is not vendored, WebKitWebDriver must be checked, chromedriver cannot download. Gap G11 |
| Visual verification with the preview app | works                             | `pnpm --filter @maus-inc/preview dev` on port 5193                                                   |
| Visual capture, `ui-capture`             | blocked                           | ffmpeg, gifsicle and a Chromium are absent. Gap G9 and G12                                           |
| Secret scan over history                 | blocked                           | the gitleaks release asset redirects to a blocked host. Gap G14                                      |
| Secret scan over config only             | works                             | `pnpm run test:secret-scan` and `node --test scripts/ci/*.test.mjs`                                  |
| Docs site build                          | works                             | astro, sharp arrives from npm                                                                        |
| Release signing and notarisation         | impossible here                   | needs a macOS runner and Apple credentials                                                           |
| Windows and macOS builds                 | impossible here                   | needs those runners, see accepted gaps                                                               |
| Dependency bumps                         | works from npm and PyPI           | crates.io needs a payload rebuild                                                                    |

## Open gaps

Each gap names the stage it blocks, the measurement, what to vendor, and the substitute to use until it exists.

### G9: the install step fails on chromedriver

Blocks dependency install, and therefore every gate that starts with a clean checkout.

Measured. A bare `pnpm install --frozen-lockfile` prints `Failed` at `chromedriver install`, then `ELIFECYCLE Command failed with exit code 1`. The payload already documents the fix in `FETCH.md` step 8, and this repository's own preflight and `AGENTS.md` did not carry it until now, so an agent that started from the repository docs hit the failure and an agent that started from `FETCH.md` did not. The install script makes a request to `https://googlechromelabs.github.io/chrome-for-testing/152.0.7977.42.json`, which fails with `ECONNRESET` because that host has no route. `chromedriver@152.0.0` is a devDependency of `apps/desktop`, and both `package.json` and `pnpm-workspace.yaml` list it in `onlyBuiltDependencies`, so its install script runs on every full install. No CI job runs the WebDriver suite, so the binary itself is only needed by `pnpm --filter desktop test:webdriver`.

What to do, in preference order.

1. Repeat `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` in `.agents/PREFLIGHT.md` and `AGENTS.md`, which now do carry it. The install script exits 0 when it sees the flag. Nothing has to be built.
2. Ship `drivers/chromedriver-152.0.0/chromedriver-linux64.zip` plus its URL and sha256, and set `CHROMEDRIVER_FILEPATH`. This is the option to take when someone intends to run the macOS WebDriver path.
3. Ship `drivers/tauri-driver` as a prebuilt binary. See G11.

Substitute today. `pnpm install --frozen-lockfile --ignore-scripts`. Name the flag in the pull request, because it also skips the other `onlyBuiltDependencies` scripts. Measured as harmless here, since esbuild and sharp resolve their platform binaries from npm optional dependencies, and `bcrypt` and `re2` are not in the lockfile.

### G10: no model weights

Blocks transcription development, the four ignored sidecar tests, and any check of transcript quality.

Measured. `huggingface.co` has no route, and 19 references in the repository point at it. `packages/rust_transcription/tests/sidecar_integration.rs` marks four tests `#[ignore]` because they download models. The whisper weights are GGML files, `ggml-tiny.bin` upward, and the ONNX models are `parakeet-ctc-0.6b`, `parakeet-tdt-0.6b`, `canary-1b` and `sense-voice`. The payload carries the ONNX Runtime and sherpa-onnx archives that load these models, and no weights.

What to vendor. A `models/` group with the smallest useful set, each with URL and sha256.

- `ggml-tiny.bin` and `ggml-base.bin`, about 75 MB and 142 MB.
- One ONNX bundle to exercise the non whisper path, `sense-voice` is the smallest.
- A `MODELS.txt` that records the upstream URL, the revision, and the digest, because a model is data and the digest is the only way to prove which data.

Do not ship the 1.5 GB whisper large model or `canary-1b` in a default payload. Add them behind a flag.

Substitute today. Unit tests that use synthesised audio buffers, and `#[ignore]` for anything that needs a real model. Say in the pull request that the model path was not exercised. Do not claim the transcription path works end to end when no model loaded.

### G11: no WebDriver driver chain

Blocks the end to end UI gate, `pnpm --filter desktop test:webdriver`.

Measured. `apps/desktop/webdriver/wdio.conf.js` spawns `~/.cargo/bin/tauri-driver` on Linux and `chromedriver` on macOS. `tauri-driver` appears in no `Cargo.lock` in this repository, so the vendored crate tree cannot build it, and `cargo install tauri-driver` needs crates.io. `webkit2gtk-driver` is in `system/PKGS.txt`, and the spec says the binary sits inside `libwebkit2gtk-4.1-0` at `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebDriver`. Confirm that path exists in the extracted sysroot before trusting it. The macOS path also needs a Chrome that matches `chromedriver@152.0.0`, which is Chrome 152.0.7977.42.

What to vendor.

- `drivers/tauri-driver/tauri-driver`, built with `cargo install tauri-driver` on an unrestricted host, plus its version.
- A check in `FETCH.md` step 10 that prints the `WebKitWebDriver` path from the sysroot.
- Optional `browsers/chrome-152.0.7977.42/` with the NSS and NSPR closure, only for the macOS path.

Substitute today. `pnpm --filter @maus-inc/preview dev` and an inspection of the demo group in both themes, written down as an inspection rather than a recording.

### G12: no media tools for UI capture

Blocks the `ui-capture` workflow that `AGENTS.md` and `.agents/skills/ui-capture/SKILL.md` require for a change a user sees.

Measured. `ffmpeg`, `ffprobe`, `gifsicle` and `tesseract` are all absent. `system/PKGS.txt` carries `libavcodec59`, `libavformat`, `libsndfile1` and `imagemagick`, so the libraries are there and the executables are not. `system/tools/bin` holds five binaries, `cmake`, `file`, `patchelf`, `pkgconf` and `pkg-config`.

What to vendor.

- `system/tools/bin/ffmpeg` and `ffprobe` as static builds, with the licence text.
- `system/tools/bin/gifsicle`.
- Optional `system/tools/bin/tesseract` plus `tessdata` for the caption OCR check. About 15 MB for English.

Substitute today. No recording. The preview app gives a rendered surface and a manual inspection gives evidence, but nothing produces a GIF. Say so plainly.

### G13: no packaging toolchain

Blocks `tauri build --bundles`, and therefore any local check of an installer. `apps/desktop/src-tauri/tauri.conf.json` sets `bundle.targets` to `all`.

Measured. Tauri resolves `linuxdeploy` and the AppImage runtime by downloading them from GitHub releases at bundle time, and those redirect to a blocked host. `dpkg-deb` is present, so the deb target has a chance, and a full release build also needs several GB of `target/`, which the workspace snapshot cap forbids.

What to vendor, if anyone needs local bundling. A `system/bundle/` group with `linuxdeploy-x86_64.AppImage`, the AppImage runtime, and a documented `TAURI_BUNDLER_TOOLS` style override. The spec records the decision to defer this, D-5. Keep it deferred until a release task lands in the sandbox.

Substitute today. Treat bundling as CI-only, and say so in the pull request.

### G14: no secret scanning binary

Blocks the history scan in `.github/workflows/secret-scan.yml`, which pins gitleaks 8.18.0 and downloads it from a GitHub release.

Measured. The release asset answers 302 to `release-assets.githubusercontent.com`, which has no route. `pnpm run test:secret-scan` and `node --test scripts/ci/*.test.mjs` still pass, because they test the scan configuration rather than run a scan.

What to vendor. `system/tools/bin/gitleaks` 8.18.0, static, with a sha256 in `MANIFEST.sha256`, and a `FETCH.md` step that puts it on `PATH`. About 30 MB.

Substitute today. Run the configuration tests, and state in the pull request that the history scan runs in CI only.

### G15: no cross-target Rust standard library

Blocks local type checking of code behind `#[cfg(windows)]` and `#[cfg(target_os = "macos")]`.

Measured. `cargo clippy` on Linux compiles only the host cfg. `test-desktop-unit.yml` runs a `rust-windows-gated` job on `windows-2022` for the code that never compiles here. The payload carries the host toolchain only, so `cargo check --target x86_64-pc-windows-msvc` fails on the missing standard library before it reaches the code.

What to vendor. `rust-toolchains/x86_64-pc-windows-msvc/rust-std` and `aarch64-apple-darwin/rust-std` from the same 1.88.0 channel, wired through `rustup toolchain link` or a direct `--sysroot`. `cargo check` does not link, so no Windows SDK is needed for a type check. This turns a "checked by CI only" note into a real local gate.

Substitute today. Say that platform gated code was checked by CI for that platform, and name the job.

## Accepted gaps

No payload closes these. Name them in the pull request rather than working around them.

- Provider API keys. The `GROQ_API_KEY` integration tests in `apps/desktop` need a key, and the sandbox has none. Do not invent one and do not skip silently.
- Audio devices. Microphone capture, the pill overlay against a real stream, and anything that needs a sound card. Use wav fixtures from `scripts/transcripts/`.
- macOS and Windows runners. Signing, notarisation, `dmg` and `msi` output, and the Cocoa and Win32 code paths.
- Containers. `config/docker-compose.yml` and the Ollama path need Docker Hub and a running daemon.
- Debian mirrors. `apt-get update` fails, so no package can be added at build time.

## What the payload already covers

So the register is not read as a list of failures.

| Group               | Covers                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `rust/toolchain`    | Rust 1.88.0, cargo, clippy 0.1.88, rustfmt                                                                                             |
| `rust/cargo-vendor` | 1114 crate directories, the union of the seven lockfiles                                                                               |
| `system/`           | Debian 12 development sysroot, `cmake`, `file`, `patchelf`, `pkgconf`, Xvfb, ImageMagick, and the GTK, WebKit, ALSA and Pulse link set |
| `native/`           | ONNX Runtime 1.23.2 and sherpa-onnx 1.13.5 linux x64 archives                                                                          |
| `LICENSES/`         | 609 licence files, so a redistributed payload stays auditable                                                                          |

## Order of work

Cheapest unblock first. Each line names the stage it opens.

1. `CHROMEDRIVER_SKIP_DOWNLOAD` documented in `FETCH.md`, `.agents/PREFLIGHT.md` and `AGENTS.md`. Opens a clean install. Costs one paragraph.
2. G14 gitleaks, about 30 MB. Opens the history scan locally.
3. G12 ffmpeg, ffprobe and gifsicle, about 90 MB with a static build. Opens `ui-capture`.
4. G15 cross-target standard libraries, about 400 MB. Opens local type checks of platform gated code.
5. G11 tauri-driver plus the `WebKitWebDriver` path check. Opens the end to end gate on Linux.
6. G10 model weights, smallest set only. Opens transcription behaviour.
7. G13 packaging, deferred until a release task has to run here.

## Rebuild triggers

The payload needs a rebuild when a `Cargo.lock` changes, when `rust-toolchain.toml` moves off 1.88.0, when `packages/rust_transcription/build.rs` or `patches/sherpa-onnx-sys-1.13.5/build.rs` pins a new archive, when `apps/desktop/package.json` moves the `chromedriver` major, or when a new native library joins the GTK or Tauri link set.

The build procedure is `engineering/sandbox-vendor-handoff-prompt.md`, and the build specification is `docs/sandbox-toolchain-vendor-spec.md`.

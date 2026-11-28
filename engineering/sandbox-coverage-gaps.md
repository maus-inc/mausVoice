# Sandbox coverage gaps

This register lists the repository verification stages that a network-restricted Linux x86-64 sandbox still cannot run even with `vendor/sandbox-toolchain`.

Read `engineering/sandbox-vendored-toolchain.md` first and check `vendor/sandbox-toolchain` (`FETCH.md`, `MANIFEST.sha256`, `system/PKGS.txt`) before citing any gap here. Report a gap number in a pull request only when an item in `Open gaps` or `Accepted environment limits` actually blocked a required gate for your diff.

On a host with unrestricted egress or native platform tooling, none of these gaps apply unless the host itself lacks the required hardware or credentials. Probe before reporting a gate as blocked.

## Open gaps

These gaps are vendorable or wiring-dependent items that remain open for restricted Linux x86-64 sandboxes.

### G10 (partial). Unvendored transcription model bundles

`vendor/sandbox-toolchain` ships Whisper `ggml-tiny.bin`, Whisper `ggml-base.bin`, and the SenseVoice ONNX bundle under `models/`. Point `RUST_TRANSCRIPTION_MODELS_DIR` at a `/tmp` copy of those directories to run the corresponding `#[ignore]` integration tests in `packages/rust_transcription/tests/sidecar_integration.rs`.

The larger bundles remain unvendored because of archive size:

- Parakeet CTC and Parakeet TDT ONNX bundles
- Canary 1B ONNX bundle
- Larger Whisper GGML weights (`small`, `medium`, `large`)

Those tests fetch from `huggingface.co`, which a restricted sandbox cannot reach. When a change touches those model loaders, run the non-ignored tests plus the vendored whisper and SenseVoice tests locally, and report `G10` for the unvendored bundles.

### G14. Release bundlers and platform installer packaging

`tauri build` packaging produces `.dmg` on macOS, `.exe`/`.msi` on Windows, and `.AppImage`/`.deb`/`.rpm` on Linux. The vendored payload does not carry `appimagetool`, `linuxdeploy`, NSIS, WiX, or signing and notarization keys.

Run compile, clippy, and test gates locally, and leave installer bundling and signing to `.github/workflows/build-desktop.yml` and `.github/workflows/release.yml`. Report `G14` when a task requires an actual release bundle check.

### G15. Bare `pnpm install` postinstall download for `chromedriver`

`chromedriver` is listed in `pnpm.onlyBuiltDependencies` in the root `package.json`. A bare `pnpm install --frozen-lockfile` executes its postinstall script, which queries `googlechromelabs.github.io` and exits non-zero when that host is blocked.

Run `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` (or `--ignore-scripts` when only `vitest` and `tsc` are needed, noting that `turbo run build` needs the `esbuild` and `sharp` postinstalls). When running `pnpm --filter desktop test:webdriver`, put `drivers/chromedriver-*` and `drivers/tauri-driver` from `vendor/sandbox-toolchain` on `PATH` instead of relying on the npm postinstall download.

## Accepted environment limits

These constraints belong to the sandbox runtime itself and cannot be closed by vendoring files. Report them explicitly when a change depends on them, and verify them on CI or a developer machine.

- **External provider credentials.** `apps/desktop/test/integration/` tests that call live APIs (such as `GROQ_API_KEY`) require real credentials and external network egress.
- **Physical audio devices.** Real microphone capture and playback require OS audio hardware. Use unit mocks and `scripts/ci/run-alsa-fault-tests.sh` for Linux fault-path coverage.
- **Native macOS and Windows linking and execution.** Cross-target `rust-std` in `vendor/sandbox-toolchain` supports `cargo check --target` for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`, but linking and executing platform-specific code (`#[cfg(windows)]`, `#[cfg(target_os = "macos")]`, `apps/windows-installer`, `packages/rust_macos_pill`, `packages/rust_windows_pill`) runs on CI runners (`windows-2022` and macOS).
- **Container runtime.** The sandbox has no Docker daemon, so the `config/` compose stack cannot run inside it.
- **Interactive desktop windowing.** Real compositor rendering and manual hardware interaction require a desktop session outside headless `xvfb` and preview harnesses.
- **Sandbox resource ceilings.** Memory limits require `CARGO_BUILD_JOBS=1` on `cargo test` to avoid linker OOM kills, and workspace snapshot caps require keeping fetched toolchains, `CARGO_HOME`, and `CARGO_TARGET_DIR` under `/tmp`.

## Closed gaps

Every gap ID below is covered by `vendor/sandbox-toolchain` on Linux x86-64. Do not report these gates as unrunnable before fetching the matching tools per `engineering/sandbox-vendored-toolchain.md` and `FETCH.md` on the branch.

| Gap ID        | Capability                                                                                                                                                                                                        | Branch location                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| G9            | `ffmpeg`, `ffprobe`, `gifsicle` for `ui-capture` video and GIF encoding                                                                                                                                           | `system/tools/bin/`                                          |
| G10 (partial) | Whisper `ggml-tiny.bin`, `ggml-base.bin`, and SenseVoice ONNX weights                                                                                                                                             | `models/`                                                    |
| G11           | `tauri-driver`, `chromedriver`, and `WebKitWebDriver` (inside the sysroot) for `pnpm --filter desktop test:webdriver`                                                                                             | `drivers/`, `system/debian12-dev-sysroot.tar.xz.part-*`      |
| G12           | `rust-std` for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin` for cross-target `cargo check`                                                                                                                 | `rust/targets/`                                              |
| G13           | `gitleaks` static binary for `pnpm run test:secret-scan` Phase 2 and commit-range secret scans                                                                                                                    | `system/tools/bin/gitleaks`                                  |
| G16           | Debuggers and syscall tracers (`gdb`, `strace`, `ltrace`, `valgrind` with `libc6-dbg`)                                                                                                                            | `system/tools/`                                              |
| G17           | Native build systems (`ninja`, `meson`, `autoconf`, `automake`, `libtool`, `m4`, `bison`, `flex`)                                                                                                                 | `system/tools/`                                              |
| G18           | Database clients (`sqlite3`, `psql`, `mariadb`, `redis-cli`)                                                                                                                                                      | `system/tools/bin/`                                          |
| G19           | OCR (`tesseract` and `eng.traineddata` for `ui-capture` caption checks)                                                                                                                                           | `system/tools/bin/tesseract`, `system/tools/share/tessdata/` |
| G20           | Shell, crypto, archive, and network utilities (`shellcheck`, `shfmt`, `gpg`, `git-lfs`, `zstd`, `brotli`, `7z`, `dig`, `tcpdump`)                                                                                 | `system/tools/bin/`                                          |
| G21           | Cross-compilers and emulation (`x86_64-w64-mingw32-gcc`, `aarch64-linux-gnu-gcc`, `qemu-aarch64-static`)                                                                                                          | `system/tools/`                                              |
| G22           | Supply-chain and SBOM scanners (`trivy`, `syft`, `grype`, `osv-scanner`)                                                                                                                                          | `system/tools/bin/`                                          |
| G23           | Native `clang-14`, `clang++-14`, and GNU binutils                                                                                                                                                                 | `system/tools/`                                              |
| G24           | Fontconfig utilities, DejaVu and Liberation fonts, `tzdata`, and `en_US.UTF-8` locale data                                                                                                                        | `system/tools/`                                              |
| G25           | Headless Chromium with its shared-library closure                                                                                                                                                                 | `system/tools/bin/chromium`, `system/tools/lib/chromium/`    |
| G26           | Additional language runtimes (OpenJDK 17 headless JRE, Ruby, CPython, Perl)                                                                                                                                       | `system/tools/`                                              |
| G27           | Profiling, diagram, document, X11, and signing tools (`perf`, `mtr`, `hyperfine`, `heaptrack`, `pandoc`, `potrace`, `plantuml`, `asciidoctor`, `exiftool`, `binwalk`, `lldb`, `xdotool`, `scrot`, `osslsigncode`) | `system/tools/`                                              |

For rebuild rules and handoff instructions, see `engineering/sandbox-vendor-handoff-prompt.md` and `docs/sandbox-toolchain-vendor-spec.md`.

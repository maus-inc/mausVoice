# General sandbox capability gaps

`engineering/sandbox-coverage-gaps.md` tracks gaps specific to this repository's verification gates. `engineering/sandbox-vendored-toolchain.md` lists everything already shipped on `vendor/sandbox-toolchain`, including the general CLI, compiler, browser, runtime, database, debugging, cross-compile, supply-chain, and document groups (G16 through G27).

This page tracks only general development capabilities that are not yet vendored on `vendor/sandbox-toolchain`, plus permanent sandbox constraints that cannot be vendored. Probe the host and check `system/PKGS.txt` and `FETCH.md` on `vendor/sandbox-toolchain` before assuming a tool is missing.

## Unvendored tools and runtimes

Add an item below to `vendor/sandbox-toolchain` only when a concrete task needs it and an unrestricted builder can package and verify it under `env -i`.

| Category                                  | Not in payload                                            | When to add                                                                           |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Additional language runtimes              | Go, .NET SDK, Node 24 runtime, Deno, Bun, PHP, Zig, Swift | A task requires compiling or running code in that runtime inside a restricted sandbox |
| Secondary browser engines                 | Firefox and `geckodriver`                                 | A task requires cross-engine browser testing beyond Chromium and WebKitGTK            |
| Extra static and policy scanners          | `semgrep`, `cosign`, `hadolint`                           | A workflow or audit requires running those scanners offline                           |
| Heavy document toolchains                 | TeX Live (`pdflatex`, `xelatex`)                          | A task requires building LaTeX PDFs locally                                           |
| Container and Windows compatibility tools | `podman`, `buildah`, `skopeo`, `wine`                     | A task requires rootless OCI manipulation or non-native PE smoke execution            |

## Permanent sandbox constraints

No vendored archive can close the limits below inside a restricted Linux container. Route work that needs them to CI runners or a developer machine.

- **Outbound network allowlist.** Any step that requires live registries, APIs, mirrors, or external release downloads outside the sandbox allowlist fails regardless of local binaries.
- **No container daemon.** Building or running `docker` or `docker compose` stacks requires a container runtime host.
- **No hardware peripherals.** GPU compute, physical microphones, audio playback devices, cameras, and Bluetooth or USB hardware do not exist in headless sandboxes.
- **No macOS or Windows host kernels.** Native `.app` signing, notarization, Xcode builds, Cocoa runtime checks, and Windows installer execution require native runners.
- **Fixed resource limits.** CPU count, RAM ceiling, and workspace snapshot size caps remain fixed by the sandbox host; keep toolchains, caches, and build directories in `/tmp`.

## Rules for adding a new capability group

Follow `docs/sandbox-toolchain-vendor-spec.md` whenever extending `vendor/sandbox-toolchain`:

1. Keep `vendor/sandbox-toolchain` as a single orphan commit and never merge it into any application branch.
2. Split any file at or above 90 MiB into `.part-NN` pieces of 94,371,840 bytes and record both the parts and the reassembled path in `MANIFEST.sha256`.
3. Record an upstream URL, a SHA-256 digest, and licence files under `LICENSES/` for every added artifact.
4. Verify every executable under `env -i` from its relocated `/tmp` tree, and document any required environment variables in `FETCH.md` on the branch.
5. Update `engineering/sandbox-vendored-toolchain.md` and `engineering/sandbox-coverage-gaps.md` in the repository to reflect what the new group covers.

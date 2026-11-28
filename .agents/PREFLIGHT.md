# Preflight checklist

Run this before every push. Paste the results and the head SHA into the Verification
Gate section of the PR body.

This file is the short form. `AGENTS.md` holds the binding rules, and the
`REVIEW.md` plus CodeRabbit loop in `AGENTS.md` still applies on top of it.

## Required local checks

- [ ] On this final committed head, read the complete `CODING_STANDARDS.md` and full base-to-head patch, then fill the per-section receipt as described in `engineering/standards-review.md`. Use the accepted receipt in the PR body. Repeat for every push.

- [ ] `pnpm install --frozen-lockfile`, or `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` on a host that cannot reach `googlechromelabs.github.io`
- [ ] `pnpm run lint`
- [ ] `pnpm run check-types`
- [ ] `pnpm run test`
- [ ] `pnpm run format:check`
- [ ] `pnpm run test:secret-scan` (for live Phase 2, ensure `gitleaks` is installed at `/usr/local/bin/gitleaks`, `/usr/bin/gitleaks`, or `/opt/homebrew/bin/gitleaks`; in a restricted sandbox, fetch the verified binary from `vendor/sandbox-toolchain` per `engineering/sandbox-vendored-toolchain.md`)
- [ ] `node scripts/ci/verify-skills.mjs` if you touched `.agents/skills/` or `skills-lock.json`
- [ ] `node scripts/ci/verify-skills.mjs` printed no `IGNORED` line, if you installed or updated a skill; fix one with a scoped `.gitignore` negation, never by deleting the file
- [ ] `pnpm gen:bindings` produced no diff, if you touched a Tauri command or `packages/desktop-native-apis`

Touched-package checks, the ones `AGENTS.md` names:

- [ ] `pnpm --filter desktop check-types` clean
- [ ] `pnpm --filter desktop lint` clean
- [ ] `pnpm --filter desktop test` pass. The `GROQ_API_KEY` integration tests may not be sandbox-available; name them if you skipped them
- [ ] `pnpm --filter @maus-inc/voice-ai test` all passed
- [ ] `pnpm --filter @repo/agent test` all passed
- [ ] `pnpm --filter @maus-inc/preview test` all passed, if you touched `apps/preview`
- [ ] `node --test scripts/ci/*.test.mjs` all passed, if you touched `scripts/ci`
- [ ] `pnpm run check:pr-body .github/pull_request_template.md` passes, and `gh pr view <n> --json body -q .body | pnpm run check:pr-body -` passes on the live body before you call it ready
- [ ] After modifying a built TypeScript package under `packages/`, rebuilt it before checking downstream consumers

## Rust checks

If you changed any of the seven Rust workspaces, run the gates for the crates you
touched. Full detail and the measured results are in `engineering/rust-toolchain.md`.

- [ ] `cargo fmt --check` in the six gated crates: `apps/desktop/src-tauri`, `packages/rust_pill_shared`, `packages/rust_gtk_pill`, `packages/rust_macos_pill`, `packages/rust_windows_pill`, `packages/rust_transcription`
- [ ] `cargo clippy --locked -- -D warnings` in `apps/desktop/src-tauri`
- [ ] `cargo clippy --locked --all-targets -- -D warnings` in `packages/rust_pill_shared`
- [ ] `CARGO_BUILD_JOBS=1 cargo test --locked --lib` in `apps/desktop/src-tauri`
- [ ] `CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --lib`
- [ ] `cargo test --locked --manifest-path packages/rust_pill_shared/Cargo.toml`
- [ ] `xvfb-run -a cargo test --locked --manifest-path packages/rust_gtk_pill/Cargo.toml`

`CARGO_BUILD_JOBS=1` stays on the test steps. Parallel linking peaks above the memory
a 3.9 GB Arena agent sandbox has and the linker dies with `signal 9`.

The pin is 1.88.0 and no crate in the tree declares a `rust-version` floor, so
`--ignore-rust-version` is never needed. Do not add it.

## Blocked sandbox

Apply this section whenever a restricted Linux x86-64 sandbox cannot reach upstream mirrors, crate registries, or GitHub Release redirects. On a host that reaches upstream hosts directly, install tooling normally and skip the vendored payload. Probe with `command -v <tool>` and `curl -m 8 -o /dev/null -w '%{http_code}' <url>` before assuming either case.

Whenever any required tool, scanner, browser, media utility, WebDriver driver, model weight, Rust toolchain, or crate registry is missing on the host, check `engineering/sandbox-vendored-toolchain.md` and the orphan branch `vendor/sandbox-toolchain` on `maus-inc/mausVoice` before reporting a gate as unavailable. This rule applies to TypeScript, UI, security, and Rust tasks alike.

- [ ] I checked `engineering/sandbox-vendored-toolchain.md` and `vendor/sandbox-toolchain` (`FETCH.md` and `system/PKGS.txt`) before marking any gate `not run`
- [ ] For standalone static binaries such as `gitleaks`, I fetched the single file via `gh api`, verified its SHA-256 against the branch manifest, and installed `gitleaks` at `/usr/local/bin/gitleaks` so `pnpm run test:secret-scan` Phase 2 runs live
- [ ] For full payload fetches, I downloaded the tarball via `codeload.github.com` into `/tmp`, reassembled `.part-*` files preserving executable bits, verified `sha256sum -c MANIFEST.sha256`, and did not run `git fetch origin vendor/sandbox-toolchain` inside the repository checkout
- [ ] I installed JS dependencies with `CHROMEDRIVER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile` (or `--ignore-scripts` only when `turbo run build` is not needed)
- [ ] When Rust checks apply: I copied `rust/cargo-config.toml` into `$CARGO_HOME/config.toml` outside the workspace, exported `CARGO_NET_OFFLINE=true` and an out-of-workspace `CARGO_TARGET_DIR`, ran without `--ignore-rust-version`, ran `cargo test` with `CARGO_BUILD_JOBS=1`, set `SHERPA_ONNX_ARCHIVE_DIR` and `MAUSVOICE_ORT_DYLIB_PATH`, put `cmake` on `PATH`, and verified no broken or absolute symlinks in the extracted sysroot
- [ ] When real-model sidecar tests apply: I wired `RUST_TRANSCRIPTION_MODELS_DIR` to the vendored Whisper (`ggml-tiny.bin`, `ggml-base.bin`) and SenseVoice models from `models/`, and reported gap `G10` only for unvendored bundles (Parakeet CTC, Parakeet TDT, Canary 1B, and larger Whisper weights)
- [ ] For every gate that genuinely remains blocked by an open gap or accepted limit in `engineering/sandbox-coverage-gaps.md` (unvendored G10 model bundles, G14 release bundlers, G15 bare install flag, or accepted hardware, credential, and native-OS limits), I named the gap ID, the reason, and the substitute check in the PR body rather than marking it passed

## UI rule

- [ ] For a change a user sees, I read `apps/desktop/DESIGN.md` first, then `apps/desktop/docs/design-system-baseline.md` and `engineering/motion-design.md`, before editing
- [ ] The component I touched has a spec in `apps/preview/specs/`, and I followed it or wrote down why I did not
- [ ] I loaded the skills the routing table in `engineering/design-skills.md` requires for this task, in its mandatory order
- [ ] I loaded `.agents/skills/stageshow/SKILL.md` and `references/craft.md` for this change, because it touches a form of UI in some file (app, pill, installer, docs, marketing, README, SVG, i18n, PR capture), and I named the mode, product or illustrated
- [ ] Product mode: I walked the `verify.md` You see / You do table against the surface in light and dark and listed every film line that would print, each fixed or explained with its state
- [ ] Illustrated mode: `film.mjs --gate` ended `rehearsal passed` at the shown width, at 390, with `--states` and with `--dark`, run from a `/tmp` copy and never inside `.agents/skills/stageshow` (use `system/tools/bin/chromium` from `vendor/sandbox-toolchain` or `scripts/verify/install-chromium.mjs` when Chrome is absent on the host); or, if a browser genuinely cannot run on the host platform, name the environment limit and give the by-eye review against the closest gold example, and place `REHEARSAL.md` beside the figure
- [ ] I said the one difference between my result and the closest gold example or shipped mausVoice surface, and fixed it when mine was the emptier, flatter, smaller or more boxed one
- [ ] I report which skills I loaded, which I refused, and what each one changed
- [ ] No hard-coded colour, radius, duration or font size in a component. Tokens come from `apps/desktop/src/styles/`
- [ ] Both light and dark modes still read correctly. This app ships both
- [ ] Every new control has a visible focus state, icon-only controls have `aria-label`, toggles have `aria-pressed`
- [ ] Every new user-visible string goes through `FormattedMessage` or `useIntl`, with no `id` prop, and the i18n extract shows no unexpected diff
- [ ] I ran `pnpm --filter @maus-inc/preview dev` and inspected the changed surface in light mode and in dark mode, or I ran `pnpm --filter desktop test:webdriver` when the WebDriver driver chain was available
- [ ] Copy is sentence case, uses `...` rather than the ellipsis character, and passed an `unslop` read

## Branch and review rules

- [ ] Work is on a focused branch, not `main`
- [ ] `git fetch origin <base>` then `git merge -m "Merge <base> into <branch>" FETCH_HEAD` ran on this branch before the first edit and again before this push, by merge and never by rebase or force-push, and `git merge-base --is-ancestor FETCH_HEAD HEAD` exits 0 on the head I am about to push
- [ ] The gates above ran on the merged tree, not on the tree from before the base came in
- [ ] I read every commit the base merge brought into a file, package, rule document or gate my work touches, and the round log says nothing, reuse, restructure or work around for each
- [ ] After the human confirmed the merge and it landed, the head branch is gone from the remote, checked with `gh api repos/<owner>/<repo>/branches/<head>`
- [ ] I did not merge any branch without the explicit human confirmation `AGENTS.md` requires
- [ ] I loaded `REVIEW.md` and ran the CodeRabbit re-review loop, up to three times, until the output is issue free
- [ ] The PR body includes the Verification Gate results and the head SHA
- [ ] I polled CI and the review bots to green rather than ending the session after one snapshot
- [ ] No unresolved review thread remains, and I resolved only threads whose fix is on the new head
- [ ] Sonar reports 0 New issues and empty annotations

## Never

- Never extract a vendored payload, run `git fetch origin vendor/sandbox-toolchain`
  into the repository's `.git` directory, set `CARGO_HOME`, `CARGO_TARGET_DIR`, or
  `RUSTUP_HOME`, or write build output inside `/home/user`. The workspace is
  snapshotted against a size and file cap. Keep all of it in `/tmp`.
- Never commit a `.cargo/config.toml` with the vendored source replacement. It breaks
  a normal `cargo build` for every other contributor.
- Never weaken or delete a test to make a gate pass. Fix the code.
- Never run a vendored skill's scripts, and never install a package to satisfy a
  skill. The limits are in `engineering/design-skills.md`.

# Preflight checklist

Run this before every push. Paste the results and the head SHA into the Verification
Gate section of the PR body.

This file is the short form. `AGENTS.md` holds the binding rules, and the
`REVIEW.md` plus CodeRabbit loop in `AGENTS.md` still applies on top of it.

## Required local checks

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm run lint`
- [ ] `pnpm run check-types`
- [ ] `pnpm run test`
- [ ] `pnpm run format:check`
- [ ] `pnpm run test:secret-scan`
- [ ] `node scripts/ci/verify-skills.mjs` if you touched `.agents/skills/` or `skills-lock.json`
- [ ] `pnpm gen:bindings` produced no diff, if you touched a Tauri command or `packages/desktop-native-apis`

Touched-package checks, the ones `AGENTS.md` names:

- [ ] `pnpm --filter desktop check-types` clean
- [ ] `pnpm --filter desktop lint` clean
- [ ] `pnpm --filter desktop test` pass. The `GROQ_API_KEY` integration tests may not be sandbox-available; name them if you skipped them
- [ ] `pnpm --filter @maus-inc/voice-ai test` all passed
- [ ] `pnpm --filter @repo/agent test` all passed
- [ ] `pnpm --filter @maus-inc/preview test` all passed, if you touched `apps/preview`
- [ ] `node --test scripts/ci/*.test.mjs` all passed, if you touched `scripts/ci`
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
a small sandbox has and the linker dies with `signal 9`.

The pin is 1.88.0 and no crate in the tree declares a `rust-version` floor, so
`--ignore-rust-version` is never needed. Do not add it.

## Blocked sandbox

A restricted sandbox reaches `github.com`, `codeload.github.com`, `api.github.com`,
`registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`. It cannot reach
`sh.rustup.rs`, `crates.io`, `static.rust-lang.org` or `huggingface.co`, and
`apt-get update` fails against every Debian mirror even though `sudo` works.

If the Rust toolchain or the crate registry is unreachable, fetch the orphan branch
`vendor/sandbox-toolchain` on `maus-inc/mausVoice` first and follow its `FETCH.md`. It
carries the toolchain, the crate registry, the Debian 12 sysroot, the command line
tools and the two native archives. Then:

- [ ] I set `$CARGO_HOME/config.toml` from the shipped `rust/cargo-config.toml`, because `cargo --config <path>` does not reach `cargo clippy`
- [ ] I exported `CARGO_NET_OFFLINE=true`
- [ ] I exported a `CARGO_TARGET_DIR` outside the workspace, so a multi-gigabyte target directory stays out of the snapshot cap
- [ ] I ran the Rust gates without `--ignore-rust-version`
- [ ] I ran `cargo test` with `CARGO_BUILD_JOBS=1`
- [ ] I set `SHERPA_ONNX_ARCHIVE_DIR` and, where needed, `MAUSVOICE_ORT_DYLIB_PATH` from the pre-seeded `native/` payloads, because the `build.rs` downloads point at GitHub Releases, which redirect to a blocked host
- [ ] I put `cmake` on `PATH` before building `packages/rust_transcription`
- [ ] I verified the sysroot before any link step: `find "$GTK_SYSROOT" -xtype l -name "lib*.so*"` and `find "$GTK_SYSROOT" -type l -lname '/*'` both print nothing
- [ ] For every gate that still cannot run, I said so in the PR body with the reason and the substitute command I ran, rather than marking it passed

The `--ignored` tests in
`packages/rust_transcription/tests/sidecar_integration.rs` download models from
`huggingface.co`. They cannot run in a sandbox. Record them as unrunnable with the
reason. Do not report them as passed.

## UI rule

- [ ] For a change a user sees, I read `apps/desktop/DESIGN.md` first, then `apps/desktop/docs/design-system-baseline.md` and `engineering/motion-design.md`, before editing
- [ ] The component I touched has a spec in `apps/preview/specs/`, and I followed it or wrote down why I did not
- [ ] I loaded the skills the routing table in `engineering/design-skills.md` requires for this task, in its mandatory order
- [ ] I report which skills I loaded, which I refused, and what each one changed
- [ ] No hard-coded colour, radius, duration or font size in a component. Tokens come from `apps/desktop/src/styles/`
- [ ] Both light and dark modes still read correctly. This app ships both
- [ ] Every new control has a visible focus state, icon-only controls have `aria-label`, toggles have `aria-pressed`
- [ ] Every new user-visible string goes through `FormattedMessage` or `useIntl`, with no `id` prop, and the i18n extract shows no unexpected diff
- [ ] Copy is sentence case, uses `...` rather than the ellipsis character, and passed an `unslop` read

## Branch and review rules

- [ ] Work is on a focused branch, not `main`
- [ ] I did not merge any branch without the explicit human confirmation `AGENTS.md` requires
- [ ] I loaded `REVIEW.md` and ran the CodeRabbit re-review loop, up to three times, until the output is issue free
- [ ] The PR body includes the Verification Gate results and the head SHA
- [ ] I polled CI and the review bots to green rather than ending the session after one snapshot
- [ ] No unresolved review thread remains, and I resolved only threads whose fix is on the new head
- [ ] Sonar reports 0 New issues and empty annotations

## Never

- Never extract a vendored payload, set `CARGO_HOME`, `CARGO_TARGET_DIR` or
  `RUSTUP_HOME`, or write build output inside `/home/user`. The workspace is
  snapshotted against a size and file cap. Keep all of it in `/tmp`.
- Never commit a `.cargo/config.toml` with the vendored source replacement. It breaks
  a normal `cargo build` for every other contributor.
- Never weaken or delete a test to make a gate pass. Fix the code.
- Never run a vendored skill's scripts, and never install a package to satisfy a
  skill. The limits are in `engineering/design-skills.md`.

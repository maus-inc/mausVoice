# mausVoice session memory

Repo: the mausVoice checkout in this workspace (shallow clone). Sandbox paths
change per session, so resolve it with `git rev-parse --show-toplevel` rather
than trusting a hardcoded path.
Read the newest `YYYY-MM-DD.md` in this directory first.

## Review workflow for this repo's PRs

- The two MANUAL reviewers are CodeAnt and CodeRabbit. The human confirmed this
  directly on 2026-11-19; it outranks AGENTS.md, which only documents CodeRabbit
  and Kilocode as taggable. Tag them in SEPARATE comments, never one command or
  one comment, so neither review request gets botched.
- `cubic` does not exist in this repo. An earlier memory line claiming "the live
  automatic reviewers are CodeAnt and cubic" was wrong and is corrected here.
  The bots that actually comment are coderabbitai, codeant-ai, sonarqubecloud,
  kilo-code-bot, deepsource-io, sourcery-ai and ahoybuoy.
- CodeRabbit auto-reviews only when the base is `main` (`.coderabbit.yaml`
  `base_branches: ^main$`), so on a PR stacked on `arena/*` it needs an explicit
  `@coderabbitai review` comment.
- CodeAnt self-resolves a suggestion it can verify, posting "CodeAnt verified this
  suggestion was addressed", a minute or two after a push. Its findings are real;
  it flagged four genuine pill defects in PR 329.
- Thread convention: reply naming the fixing SHA, then resolve via
  `resolveReviewThread`. Keep a documented not-applicable thread open for the
  maintainer rather than resolving a refusal yourself.
- Round-summary PR comments are the house style, one per review round, with a
  table of finding + root cause.

## Pill crates

- `packages/rust_pill_shared`, `rust_windows_pill`, `rust_macos_pill`,
  `rust_gtk_pill`. `apps/desktop/src-tauri` path-depends on `rust_pill_shared`
  and `rust_macos_pill`.
- Save/restore defect class to watch: a retained value (drop rect) paired with a
  live-read value (window screen / monitor / work area). Retain the whole record
  at one instant.

## Environment

- Offline toolchain via `. ./setup-toolchain.sh` (CARGO_HOME=/tmp/cargo-home,
  CARGO_BUILD_JOBS=1). pnpm 10.34.5 via corepack at `/tmp/bin/pnpm`.
- `vendor/sandbox-toolchain` carries a `native/` tree: `native/onnxruntime/`
  and `native/sherpa-onnx/`. The two transcription `build.rs` scripts download
  those archives from GitHub Releases when `MAUSVOICE_ORT_DYLIB_PATH` and
  `SHERPA_ONNX_ARCHIVE_DIR` are unset, which fails where that host is blocked.
  Verify a "no such payload exists" claim against the remote branch first.
- `pnpm run check-types` needs `pnpm run build` first for `apps/preview`.
- `pnpm run test` fails 3 `apps/desktop` files without `GROQ_API_KEY` (pre-existing).
- Run cargo clippy detached (`setsid`); the foreground tmux session can die.

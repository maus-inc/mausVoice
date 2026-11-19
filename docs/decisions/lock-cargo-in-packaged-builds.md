# Packaged builds must honor Cargo lockfiles

Date: 2026-11-08
Status: accepted

## Context

PR 317's Socket report flagged `web-sys` 0.3.107 with a supply-chain score of
13. The repository's tracked Cargo lockfiles currently resolve `web-sys` to
0.3.94 in the desktop and Windows installer workspaces and 0.3.104 in the
transcription workspace. The patched CPAL manifest also declares `web-sys` for
WebAssembly targets with a compatible version range. The report alone does not
establish which path caused Socket to select 0.3.107.

Socket's [0.3.107 alerts page](https://socket.dev/cargo/package/web-sys/alerts/0.3.107)
lists install scripts, network, shell, environment and filesystem access for
the package and its dependencies. The published
[manifest](https://socket.dev/cargo/package/web-sys/files/0.3.107/web-sys-0.3.107/Cargo.toml)
sets `build = false` for `web-sys` itself. This does not establish that its
dependencies are safe or that every alert is a false positive. Socket also
scores the locked [0.3.94](https://socket.dev/cargo/package/web-sys/overview/0.3.94)
and [0.3.104](https://socket.dev/cargo/package/web-sys/overview/0.3.104) at
13, so replacing 0.3.107 with either version would not resolve the reported
risk by itself.

The release and desktop build workflows tested Rust with `--locked`, but their
Tauri build commands did not pass it to Cargo. The Windows native pill sidecar
build also omitted it. A build could therefore resolve a different dependency
graph from the one reviewed in the lockfile.

## Decision

The desktop CI and release workflows pass `-- --locked` to Tauri. The native
Windows pill sidecar build passes `--locked` directly to Cargo. The transcription
sidecar build already uses `--locked`. Tauri documents that arguments after
`--` reach its build runner, and Cargo documents that `--locked` fails if the
lockfile is absent or needs a different resolution.

- [Tauri CLI build arguments](https://v2.tauri.app/reference/cli/)
- [Cargo lockfile options](https://doc.rust-lang.org/cargo/commands/cargo.html)

## Consequences

A stale or missing lockfile now fails these packaged builds instead of silently
changing their dependency graph. A deliberate update still requires reviewing
and committing the new lockfile. The regression guard in
`scripts/ci/cargo-lock-builds.test.mjs` checks the workflow commands and the
pill build arguments. Platform build jobs must still verify the real packaging
path.

This limits unreviewed resolution changes. It does not clear Socket's warning,
prove the locked packages safe, cover standalone unlocked local builds, or
replace a dependency audit. Investigate the report's exact alert locations and
the dependency graph before accepting or dismissing the remaining risk.

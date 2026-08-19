# Handoff: gate desktop DevTools to QA artifacts

Copy the prompt below to an agent/session that has permission to update GitHub
workflow files. The workflow changes are deliberately excluded from this branch so it can be
pushed with a token that lacks the `workflows` permission. The prompt tells a
workflow-authorized agent how to apply those omitted CI/release changes later.

```text
You are continuing the dev-surface gating work for maus-inc/mausVoice.

Work only on the branch `arena/01a0177a-mausvoice`. The current branch contains the runtime gate but intentionally does not contain
the workflow edits. Apply the omitted workflow changes from the instructions
below in a workflow-authorized session, then push exactly this branch:

  git push origin arena/01a0177a-mausvoice

Reproduce the complete intended change from base
`078a7fc98fa662ba16669a0e1382075c0270a972`:

1. In `apps/desktop/src-tauri/Cargo.toml`, add this immediately after `[lib]`:

   [features]
   # Never enable this in a stable release: it compiles Tauri's inspection
   # capability into the binary. CI and prerelease workflows opt in explicitly.
   debug-assist = ["tauri/devtools"]

   Remove `"devtools"` from Tauri's unconditional dependency feature list.

2. In `apps/desktop/src-tauri/src/app.rs`, make the existing
   `MAUSVOICE_ENABLE_DEVTOOLS` opening block compile only with:

   #[cfg(feature = "debug-assist")]

   Keep the runtime environment-variable check inside that conditional block.
   A stable binary must not contain the Tauri DevTools feature, so setting the
   environment variable in a stable build must be ineffective.

3. In `apps/desktop/package.json`, add `--features debug-assist` to:
   - the `pnpm tauri dev` command used by `dev:tauri`;
   - the `pnpm tauri build --debug` command used by `build:mac:debug`.

4. In `.github/workflows/build-desktop.yml`, change the CI artifact build to:

   pnpm run tauri build --ci --features debug-assist ${{ matrix.args }}

5. In `.github/workflows/release.yml`, give the Build Tauri app step:

   MAUSVOICE_PRERELEASE: ${{ inputs.prerelease }}

   Then use a shell conditional: run with `--features debug-assist` only when
   `MAUSVOICE_PRERELEASE` equals `true`; otherwise run the existing build command
   with no features. Stable release artifacts must not compile DevTools.

6. Add `scripts/ci/dev-surface-contracts.test.mjs`. It must source-test all of
   the following:
   - `debug-assist = ["tauri/devtools"]` is the only path to DevTools;
   - app.rs has the `#[cfg(feature = "debug-assist")]` startup gate;
   - local dev/debug and ordinary CI builds opt in;
   - release workflow opts in only for `inputs.prerelease == true`.

The intended artifact matrix is:

| Build | debug-assist | DevTools / Inspect |
| --- | --- | --- |
| Local dev and local debug | enabled | available |
| Ordinary CI build artifact | enabled | available |
| Dispatcher prerelease | enabled | available |
| Stable release | omitted | unavailable at compile time |

No tracked TS, Rust, or native-pill source renders a top-right window-size
readout. The full source search found only legitimate resize handling and
pill-size IPC. Treat that readout as a DevTools/WebView debug surface; do not
change `WindowResizeHandles` or normal resize behavior.

Run at minimum:

  node --test scripts/ci/dev-surface-contracts.test.mjs
  git diff --check

Also run the repository-required desktop/Rust/root quality gates when the
required pnpm and cargo executables are installed:

  pnpm --filter desktop check-types
  pnpm --filter desktop lint
  pnpm --filter desktop test
  (cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy && cargo test)
  pnpm run build

Commit with:

  git commit -m "fix(desktop): restrict devtools to QA artifacts"

Push `arena/01a0177a-mausvoice`, then open or update a PR targeting the same
base as PR #63 (`main`). Mention that this protects stable artifacts by
compile-time feature removal rather than an environment-variable runtime gate.
```

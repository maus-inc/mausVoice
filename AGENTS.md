** Rules **

- Do not propose band-aid fixes to problems. Identify the root cause, be it architectural or logical, and address it directly. Don't be afraid to remove broken code. If something is broken, fix it at the root, even if that means refactoring and overhauling systems (if necessary).
- NEVER MERGE ANY BRANCH WITHOUT FIRST CONFIRMING WITH THE HUMAN IN THE LOOP, THE BRANCH BEING MERGED INTO AND "EXPLICIT" CONFIRMATION IN EXACT WORDING; Yes Merge Branch X(Branch/PR Name ABC) into Branch Y(Branch/PR Name XYZ).
- Enforce DRY code principles. If you find yourself copying and pasting code, stop and refactor it into a reusable function or module.
- Avoid over-engineering. Implement solutions that are as simple as possible while still meeting requirements.
- Your changes should have minimal impact. Do not break existing functionality.
- Write clear, maintainable code that is self documenting. Do not comments on new code except where it's necessary to explain non-obvious things.
- Prefer to follow existing patterns such as dialogs, state management, and API interactions, etc.

** Writing style (docs, README, marketing copy) **

- Before writing or editing any user-facing prose, load the `unslop` skill from `pstack/skills/unslop` in https://github.com/cursor/plugins and apply its rules.
- In short: no em dashes (and no parentheses or connector colons as substitutes), straight quotes only, sentence-case headings, active voice with a named actor, plain words over jargon, no chatbot phrases or filler, and concrete facts (paths, numbers, mechanisms) instead of feel-good abstractions.
- These rules were applied to `README.md` and every page under `apps/docs/src/content/docs/` in PR #119; keep new prose consistent with them.

** Repository structure **

- This is a Turborepo monorepo. Root-level: `pnpm run build`, `pnpm run lint`, `pnpm run check-types`, `pnpm run test`.
- Shared packages live in `packages/` (`@maus-inc/types`, `@maus-inc/utilities`, `@maus-inc/voice-ai`, **`@repo/agent`**, `@maus-inc/desktop-utils`, `@maus-inc/desktop-native-apis`, firemix, shared-fonts, eslint-config, typescript-config, and the native pill/transcription Rust crates). After modifying a built TypeScript package, rebuild it before downstream consumers can see changes. Dev Node is `.nvmrc` **v24** (`engines` `>=20`).
- Use `<FormattedMessage defaultMessage="..." />` or `useIntl()` for i18n — never pass an `id` prop.

** `apps/desktop` — Tauri desktop app (Rust + TypeScript/React) **

- "Rust is the API, TypeScript is the Brain" — all business logic lives in TypeScript, never duplicated in Rust. Rust provides pure API capabilities without decision-making.
- Single source of truth for state is Zustand (with Immer) in TypeScript.
- Data flow: User/Native Event → Actions (`src/actions/`) → Repos (`src/repos/`) → Tauri Commands (`src-tauri/src/commands.rs`) → SQLite / transcription sidecar / external providers.
- Repos resolve to local implementations in this build. `BaseXxxRepo` defines the interface and `LocalXxxRepo` (and `PersonalAuthRepo`) implements it. Use `toLocalXxx()` / `fromLocalXxx()` at the Tauri boundary.
- Local transcription runs in the `packages/rust_transcription` sidecar (whisper.cpp GGML and ONNX Parakeet/Canary), not in-process.
- Database migrations go in `src-tauri/src/db/migrations/` as `NNN_description.sql`, then `include_str!` and register them in `db/mod.rs`. Numbering is intentionally irregular (021, 069, and 070 are absent) — never renumber applied migrations.
- New Tauri commands: define in `commands.rs`, register in `app.rs` invoke_handler, expose via Specta + `pnpm gen:bindings`, wrap in a repo, and call it from an action.

** `apps/docs` — Documentation site (Astro + Starlight) **

- Scripts: `pnpm run dev`, `pnpm run check-types`, `pnpm run build`.
- This site is the authoritative, maintained documentation. Prefer updating it (under `apps/docs/src/content/docs/`) over the loose notes in the repo-root `docs/` folder.

** `apps/windows-installer` — Windows installer (Tauri) **

- Build on Windows with `pnpm run tauri:build`.

**Tauri CSP & security notes**

- `tauri.conf.json` has a restrictive CSP (`script-src 'self'` with no `unsafe-inline` or `unsafe-eval`). The `dangerousDisableAssetCspModification: ["style-src"]` setting disables Tauri's automatic injection of CSP directives for the `asset:` protocol on the `style-src` directive only. This preserves `style-src 'self' 'unsafe-inline'` so Emotion/MUI runtime styles work correctly. The `assetProtocol.scope` (set to `$APPDATA/transcription-audio/**`) independently controls which local files the `asset:` protocol may serve — these are two separate concerns. This does NOT relax `script-src` or other sensitive directives. Do NOT expand the `dangerousDisableAssetCspModification` array beyond `["style-src"]` without explicit security review.
- `remote.urls` in capabilities is restricted to localhost loopbacks. External API domains (OpenAI, Anthropic, Groq, Deepgram, etc.) are allowlisted in the `http:default` permission set, NOT in `remote.urls` — they are reachable through curated HTTPS provider calls but cannot access IPC commands. Keep this distinction when adding new providers.
- Plain HTTP is intentionally absent from `http:default`: capability globs are hostname patterns, not CIDR. User-configured loopback/RFC1918/unique-local/`.local` endpoints must use `src/utils/secure-fetch.utils.ts`, which routes them through Rust's `private_http_request` host and redirect validation. Never add `http://10.*`, `http://192.168.*`, `http://172.*`, or link-local `169.254.*` globs.
- CSP `connect-src` mirrors the external HTTPS API allowlist; both lists must be kept in sync when adding/removing providers. The `img-src` and `frame-src` directives are scoped to known-safe origins (avatar hosts, YouTube embeds). Never add a wildcard (`*`) to any CSP directive.

** Important scripts **

- `pnpm gen:bindings` — regenerate `packages/desktop-native-apis/src/bindings.ts` from the Specta-facing Rust commands after changing `#[tauri::command]` signatures or exposed types.
- `pnpm --filter desktop i18n` — extract/prune messages and synchronize the locale catalogs after changing user-facing strings.
- `pnpm --filter desktop dev:mac` / `dev:windows` / `dev:linux` — run the desktop app for a specific platform.

** Rust toolchain & build environment **

- Honor the pinned toolchain. The repo pins `channel` and `components` in `rust-toolchain.toml` (currently `1.88.0` with `clippy` and `rustfmt`). Do not override it with a newer stable. `cargo` reads the file automatically once the toolchain is installed.
- Install rustup if it is missing, then install the pinned toolchain and its components:

  ```
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
  . "$HOME/.cargo/env"
  rustup toolchain install 1.88.0 --profile minimal
  rustup component add --toolchain 1.88.0 clippy rustfmt
  ```

- Install the Linux system dependencies that the Tauri desktop crate needs to compile. On Debian/Ubuntu (run as root or with `sudo`):

  ```
  apt-get update
  apt-get install -y build-essential pkg-config cmake \
    libgtk-3-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev libasound2-dev \
    libxdo-dev libgtk-layer-shell-dev libssl-dev protobuf-compiler
  ```

  Pick `libwebkit2gtk-4.1-dev` when available. Fall back to `libwebkit2gtk-4.0-dev` on older distros.
- A C linker (`cc`/`gcc`) is required. `build-essential` provides it. If `cargo` reports "no default linker", install `build-essential` and re-open the shell.
- CI runs these Rust checks (replicate them locally before claiming done):
  - `apps/desktop/src-tauri`: `cargo clippy -- -D warnings` and `cargo test --lib`
  - `packages/rust_gtk_pill`: `cargo clippy --all-targets -- -D warnings` and `cargo test`
  - `packages/rust_pill_shared`: `cargo test`
  Set `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` so the build does not require external binaries.
- First builds are slow (Tauri pulls many crates). Expect several minutes for the initial `cargo check`/`clippy`/`test`. Later runs are fast because `target/` is cached.

** Persistence: do not give up on the Rust/build steps **

- Treat Rust toolchain and system-dependency setup as mandatory, not optional. The desktop app does not compile without the system libraries listed above.
- Network errors, missing targets, and linker failures are expected in a fresh environment. Diagnose each failure, install the missing piece, and re-run. Do not skip the Rust steps or stub them out.
- If a `cargo` command fails, read the actual error. Common fixes: install the named system package, add a missing `rustup` target, or re-run after `apt-get install`. Iterate until `cargo clippy` and `cargo test` are green.
- If `cargo run --example gen_bindings` is required (Specta bindings), build it once. The first run compiles the example; later runs are quick. A 240s tool timeout can interrupt the first build, so run long `cargo` commands with a larger timeout or in the background and poll the logs.
- A full headless Tauri GUI build may be impossible without a display. In that case, satisfy CI equivalence with `cargo check`/`clippy`/`test` for the Rust packages, regenerate the Specta bindings, and typecheck the frontend. Document any check you could not run rather than claiming success.

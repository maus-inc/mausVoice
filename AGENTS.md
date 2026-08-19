** Rules **

- Do not propose band-aid fixes to problems. Identify the root cause, be it architectural or logical, and address it directly. Don't be afraid to remove broken code. If something is broken, fix it at the root, even if that means refactoring and overhauling systems (if necessary).
- Enforce DRY code principles. If you find yourself copying and pasting code, stop and refactor it into a reusable function or module.
- Avoid over-engineering. Implement solutions that are as simple as possible while still meeting requirements.
- Your changes should have minimal impact. Do not break existing functionality.
- Write clear, maintainable code that is self documenting. Do not comments on new code except where it's necessary to explain non-obvious things.
- Prefer to follow existing patterns such as dialogs, state management, and API interactions, etc.

** Repository structure **

- This is a Turborepo monorepo. Root-level: `pnpm run build`, `pnpm run lint`, `pnpm run check-types`, `pnpm run test`.
- Shared packages live in `packages/` (types, utilities, voice-ai, agent, desktop-utils, desktop-native-apis, firemix, shared-fonts, eslint-config, typescript-config, and the native pill/transcription Rust crates). After modifying a built TypeScript package, rebuild it before downstream consumers can see changes.
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
- `remote.urls` in capabilities is restricted to localhost loopbacks. External API domains (OpenAI, Anthropic, Groq, Deepgram, etc.) are allowlisted in the `http:default` permission set, NOT in `remote.urls` — they are reachable via the webview's own fetch() but cannot access IPC commands. Keep this distinction when adding new providers.
- CSP `connect-src` mirrors the same external API allowlist; both lists must be kept in sync when adding/removing providers. The `img-src` and `frame-src` directives are scoped to known-safe origins (avatar hosts, YouTube embeds). Never add a wildcard (`*`) to any CSP directive.

** Important scripts **

- `pnpm gen:bindings` — regenerate `packages/desktop-native-apis/src/bindings.ts` from the Specta-facing Rust commands after changing `#[tauri::command]` signatures or exposed types.
- `pnpm --filter desktop i18n` — extract/prune messages and synchronize the locale catalogs after changing user-facing strings.
- `pnpm --filter desktop dev:mac` / `dev:windows` / `dev:linux` — run the desktop app for a specific platform.

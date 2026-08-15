# mausVoice Review & Hardening Handbook

A condensed reference for agents and engineers working on `mausVoice`. It distills the architectural contracts, security boundaries, and recurring findings raised across historical PRs by automated reviewers (CodeRabbit, Kilo Code) for both the Rust (Tauri) backend and the React/TypeScript frontend.

**Contents:** 1. Reviewer personas · 2. Pre-release audit protocol · 3. Rust backend · 4. Frontend · 5. CI/CD & monorepo · 6. Suggestions & nitpicks · 7. Anti-pattern checklist

---

## 1. Reviewer Personas

### 1.1 CodeRabbit — assertive audit posture

Prioritizes functional correctness, security, edge cases, memory leaks, and concurrency over style. Traits:

- **Context-aware analysis:** parses the whole PR and traces data flow (React input → IPC → Rust → SQLite/OS APIs) using AST matching (`ast-grep`) and `rg`, plus historical learnings.
- **Edge-case assertion:** if a state is physically reachable, it will be reached. Checks bounds, buffer sizes, network failures, races.

Finding anatomy: severity (`🔴 Critical` arbitrary write / injection / crash · `🟠 Major` bugs, leaks, races, unhandled rejections · `🟡 Minor` idioms, docs) → contextual *why* with file:line → committable diff → a `<details>` prompt scoping a minimal fix for downstream AI agents.

### 1.2 Kilo Code (kilocode-bot) — precision review

- **Contract enforcement:** code must live up to its own comments. A doc claiming "traversal cannot escape" triggers an audit for real canonicalization; comment/code drift is a high-priority bug.
- **Tautological test detection:** rejects tests asserting a hardcoded constant against a hardcoded copy; demands dynamic schema/runtime extraction.
- **Resource-leak tracking:** file handles closed, workers terminated, rejections logged not swallowed.

---

## 2. Pre-Release Audit Protocol

### 2.1 Scope
Audit the **FULL diff** against the target release branch — not just headline files — tracing each change through its complete dependency chain from UI down to filesystem and hardware.

### 2.2 Self-review gate (Cause → Action → Reaction → Necessity)
Every candidate finding must survive all four checks, or be discarded:

1. **Cause:** is the root cause in *this* diff, or pre-existing on base?
2. **Action:** does the fix compile and match workspace types/idioms? Untested hand-written refactors are prohibited.
3. **Reaction:** trace all call sites — does it break consumers or add races, contention, or CI lint errors?
4. **Necessity:** genuine bug/security/performance issue, or style opinion?

### 2.3 Verdict format
`## Verdict: **Ready**` or `**Not Ready**`, plus `Confidence: **[High/Medium/Low]**`, `Mergeable: **[Yes/No]**`, `CI Verification: **[Passing/Failing/Pending]**`.

### 2.4 Coverage checklist (trace all ten; omit none)

1. **Merge state:** conflicts, safety of automated rebase.
2. **IPC boundary:** every new/changed `tauri::command` — payload type validation, safe integer bounds (`u64` → JS `Number` precision), array/buffer bounds, discriminated-union results instead of thrown errors.
3. **State machine / lifecycle:** cancellation on unmount, stale-callback rejection via generation counters or tokens, re-entrancy guards on serial ops (keystroke streams), release of handles and hardware streams on teardown.
4. **Persistence:** localStorage / app-config / SQLite — single source of truth (no drifting dual writes), migration safety, `ROLLBACK` on partial failure.
5. **UI logic:** controlled inputs (no uncontrolled→controlled), exhaustive hook dependency arrays, explicit listener teardown, explicit pending/disabled/loading/empty/error states.
6. **UI review:** spacing on a consistent grid; WCAG AA contrast and typography; focus rings, modal focus trapping, platform shortcuts (`Cmd` vs `Ctrl`); scoped transitions only (never `transition: all`); theme continuity with no un-themed flash.
7. **Edge cases:** empty arrays / zero-length buffers, `null` vs `undefined` vs missing JSON fields, platform variation (`\r\n`, path layouts), boundary data (silent audio, empty prompts).
8. **Security & sandboxing:** URL scheme validation, Tauri scope limits, `../` traversal and canonicalization guards, webview XSS.
9. **Test coverage:** untested new behaviors and invariants.
10. **Lint/CI:** `oxlint`, `prettier`, `clippy` clean; no new warnings.

### 2.5 Report structure
Seven sections, in order: `## Verdict` · `## Major findings` · `## Minor findings` · `## Nitpick findings` · `## UI review findings` · `## Missing important test coverage` · `## What is working correctly`. Findings use **[Severity — Title]**, `File:Line`, *The Problem:*, *The Solution:* (or *Context:* / *Details:* for minor, nitpick, UI, test, and positive entries).

---

## 3. Rust (Tauri) Backend

### 3.1 Subprocess management
**Traps:** `wait_with_output()` buffers unbounded stdout/stderr into RAM (OOM); timing out without `kill()` + `wait()` leaks zombies; not draining pipes concurrently deadlocks a chatty child on a full pipe buffer; `Command::new` cannot run CMD builtins (`dir`, `echo`, `ver`) — only real executables.
**Pattern:** drain stdout *and* stderr on background threads with an explicit byte cap (keep draining past the cap), keep the `Child` handle and kill+reap on timeout (don't unconditionally join readers afterwards — descendants may hold the pipe), and allow-list genuine binaries only.

### 3.2 File I/O, paths, symlinks
**Traps:** validating a relative path against `audio_dir` but passing the *raw* input to `remove_file` resolves against CWD; `.starts_with(audio_dir)` is lexical and loses to `..` and symlinks; an un-canonicalized `audio_dir` makes every comparison fail silently.
**Pattern:** canonicalize both the file's parent and the target directory before comparing; reject symlinks at the final component via `symlink_metadata` (but allow not-yet-existing destinations); always delete/operate on the canonical `PathBuf` your validator returns, never the raw string.

### 3.3 Network streaming & redirects
**Traps:** default redirect policies follow untrusted hosts; trusting `Content-Length`; unbounded writes to disk.
**Pattern:** a custom `redirect::Policy` validating host/scheme and capping hops; reject oversized advertised lengths up front; enforce the cap again with a per-chunk byte counter and delete the partial file on breach. Treat a missing `Content-Length` as a policy choice — require it for fixed artifacts from hosts you control, allow `None` where chunked/compressed responses are legitimate.

### 3.4 Concurrency & test integrity
**Traps:** a process-global `CANCEL_TYPING` flag with no session key lets session A's late cancel abort session B; cargo runs tests in parallel threads, so writing shared statics randomly fails other tests.
**Pattern:** key cancellation to a session and no-op outside an active one; in tests, wrap global access in helpers and restore prior values with a `Drop` guard.

### 3.5 SQLite & migrations
**Traps:** tautological table assertions (a hardcoded list vs. its copy) let a new table escape the privacy wipe; per-table deletes without a transaction leave partial wipes.
**Pattern:** tests read the live schema (`sqlite_master`), subtract an explicit allow-list (`sqlite_%`, `_sqlx_migrations`), and assert every remaining table is in `USER_DATA_TABLES_TO_CLEAR`; wrap wipes in `pool.begin()`.

### 3.6 IPC, CORS, CSP
Keep `remote.urls` restricted to localhost loopbacks — wildcards give any loaded page (docs mirrors included) native command access. External domains stay IPC-free webviews. Keep CSP in `tauri.conf.json` synchronized with production (`script-src 'self'`), and scrub stale comments claiming IPC access the config no longer grants.

### 3.7 Native pills & window geometry
Offset toplevel coordinates by half the window width/height so Linux/X11 drags match macOS and Windows center anchoring (raw origins make the pill jump monitors). Use inclusive boundary probes and place fallbacks strictly inside the screen (e.g. `max - 1.0`) so the pill never lands off-screen.

### 3.8 Model cache contention
Holding `MODEL_CACHE.lock()` across a whole inference serializes every transcription. **Acquire, clone the runtime handle, `drop(cache)`**, then run the heavy computation unlocked.

### 3.9 ONNX auxiliary artifacts
Never `let _ = tokio::spawn(...)` companion downloads (tokenizers, vocabs, configs) — dropped join handles hide failures and leave models silently half-installed. Aggregate the artifact futures and `tokio::try_join!` them before reporting ready. In tests, poll readiness instead of sleeping a fixed duration.

---

## 4. TypeScript & React Frontend

### 4.1 Hooks & StrictMode
Never assign `ref.current` or set state during render — StrictMode's double render corrupts it. A ref-guarded controller built once (`if (!ref.current) ref.current = new Controller(options)`) freezes later `options` (e.g. `timeoutMs`). Do setup in `useEffect`, and pass dynamic config as call arguments (`controller.run(promise, timeoutMs)`).

### 4.2 Async state & races
Two overlapping reloads can let the older response overwrite newer data; state set after unmount leaks. Use a **monotonic generation counter** in an async controller — increment on each `run()`, and bail out of every completion, error, timeout, and cleanup path whose generation no longer matches. Return a teardown from `useEffect` that increments the generation and clears timers.

### 4.3 IPC bindings
Never hand-edit `bindings.ts` — regenerate via `scripts/bindings.sh` or the cargo build flow after changing `commands.rs`, and register every new command in the builder in `app.rs`.

### 4.4 Audio input safety
Close/pause microphone streams in `useEffect` cleanup or the OS recording indicator stays lit and handles leak. Iterate `Float32Array` PCM with built-in array methods or explicit range guards, never unchecked C-style indexing.

### 4.5 Default device drop-off
If the default device's display name fails to resolve, fall back to a placeholder like `"System Default"` — returning `None` strips `is_default` and the UI shows no default mic. Cache and target devices by stable hardware ID instead of re-enumerating by label on every recording toggle.

---

## 5. CI/CD & Monorepo

- **5.1 Turbo graph:** `"check-types": { "dependsOn": ["^check-types"] }` yields spurious `TS2307` because dependencies were never built. Depend on `["^build"]`.
- **5.2 Least privilege:** verification jobs (format, lint, typecheck, cargo test) get `permissions: contents: read`; write scopes only in publish/release steps.
- **5.3 Trigger filters:** desktop `paths` filters must cover everything affecting compilation — `apps/desktop/**`, `packages/**`, `patches/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.github/scripts/install-desktop-linux-deps.sh`.
- **5.4 Dependency floors:** keep both bounds in overrides — `"vitest@<3.2.6": ">=3.2.6 <4.0.0"`. Dropping the floor permits a downgrade back into vulnerable `3.x`.
- **5.5 Updater trust anchors:** never commit signing keys or `__UPDATER_PUBLIC_KEY__` literals (a fork could sign binaries the app auto-trusts), and never duplicate the literal across CI and setup scripts. Set `"createUpdaterArtifacts": false` publicly and inject `TAURI_UPDATER_PUBLIC_KEY` from repository secrets during the release build only.
- **5.6 Platform symmetry:** if `rust_windows_pill` gets `cargo test`, so must `rust_macos_pill` and `rust_gtk_pill` — clippy-only coverage hides runtime bugs. Provision tools (e.g. `imagemagick`) in the platform dependency scripts, not loose inline installs without `apt-get update`.
- **5.7 Boolean casts:** `"false"` is truthy in Node and Python, so `CI=false` reads as "in CI". Compare explicitly: `process.env.CI === "true"`.

---

## 6. Suggestions & Nitpicks

**Suggestions** (`🟡 Minor` / `🔵 Trivial`) — performance, maintainability, defensive coding: strip dead variables, imports, and ignored parameters; prefer safe option handling (`unwrap_or_default()`, `if let Some`, `?.`, `??`) over risky unwraps; adopt modern idioms (`std::mem::take`, iterator combinators over C-style loops; `async/await` over `.then` chains); avoid holding a mutex across a nested call that causes micro-contention and render delay.

**Nitpicks** — zero functional impact: formatting drift and stray/trailing whitespace, missing trailing newline at EOF, comments that contradict the code they describe (e.g. "throws X" after a rewrite to `Result`), and descriptive renames following monorepo casing (camelCase TS, snake_case Rust).

**Linter boundaries:** **Oxlint** scans `apps/desktop/src` per `apps/desktop/oxlint.json` via `pnpm --filter desktop run lint` (which also runs a Prettier check); **Prettier** covers TS/TSX, CSS, and Markdown through the root `format` script; **Clippy** runs `cargo clippy -- -D warnings` for the Tauri backend and each native pill crate. There is **no ESLint or Markdownlint in CI** — Markdown structure findings are readability nits, not gates. Verify proposed suggestions don't themselves break these checks.

---

## 7. Anti-Pattern Checklist

| Category | Smell / Anti-Pattern | Severity | Remediation |
| :--- | :--- | :--- | :--- |
| Rust Security | Raw string path deletions | Critical | Canonicalize; act on the returned `PathBuf` |
| Rust Security | Unvalidated HTTP redirects | Critical | Custom policy verifying host, scheme, hop count |
| Rust Security | Over-permissive `remote.urls` | Critical | Restrict IPC capability to loopback |
| Rust Performance | Buffering subprocess output in RAM | Major | Stream via capped concurrent readers |
| Rust Concurrency | Parallel tests mutating statics | Major | Scope access; restore in a `Drop` guard |
| Rust Concurrency | Mutex held across long async work | Major | Clone under a short lock, drop, then run |
| Rust Robustness | Tautological constant tests | Major | Parse the live schema in tests |
| Rust Operations | Fire-and-forget companion spawns | Major | Aggregate and await the full artifact set |
| Rust UI | Exclusive max bounds in geometry | Medium | Place strictly within screen bounds |
| React Hooks | Writing refs during render | Major | Move into `useEffect` or pure setters |
| React Safety | Stale cached controllers/config | Major | Pass dynamic params per call |
| React Lifecycle | State set after unmount | Medium | Generation counter discards stale updates |
| TS Hardware | Default input dropped on label scan | Medium | Placeholder label for unnamed defaults |
| TS Performance | Label lookups each hardware cycle | Minor | Target cached, stable device IDs |
| CI / CD | Over-privileged `GITHUB_TOKEN` | Medium | `contents: read` on verification jobs |
| Turborepo | Tautological task dependencies | Medium | Depend on `^build` |
| CI Security | Committed updater keys | Critical | Inject from secrets at release time |
| CI Coverage | Asymmetrical per-platform tests | Major | Symmetrical `cargo test` on all targets |
| Script Safety | Env vars cast to boolean | Medium | Explicit string comparison |
| Clean Code | Dead variables and imports | Minor | Strip for a clean Oxlint pass |
| Formatting | Missing heading blanks / EOF newline | Nitpick | Normalize Markdown formatting |
| Documentation | Comments contradicting signatures | Nitpick | Rewrite docs to match the code |
/home/user/mausVoice/REVIEW.md
# mausVoice Review & Hardening Handbook

Condensed reference for agents and engineers on `mausVoice`: the architectural contracts, security boundaries, and recurring findings raised across historical PRs by automated reviewers (CodeRabbit, Kilo Code) for the Rust (Tauri) backend and React/TypeScript frontend.

---

## 1. Reviewer Personas

**CodeRabbit** runs an assertive audit posture: correctness, security, edge cases, leaks, and concurrency over style. It parses the whole PR and traces data flow (React input → IPC → Rust → SQLite/OS APIs) with AST matching (`ast-grep`) and `rg`, and assumes any physically reachable state will be reached. Findings carry a severity (`🔴 Critical` arbitrary write / injection / crash · `🟠 Major` bugs, leaks, races, unhandled rejections · `🟡 Minor` idioms, docs), a *why* with file:line, a committable diff, and a `<details>` prompt scoping a minimal fix for downstream agents.

**Kilo Code** reviews for precision: code must live up to its own comments (a doc claiming "traversal cannot escape" triggers an audit for real canonicalization; drift is a high-priority bug); it rejects tautological tests that assert a hardcoded constant against its own copy, demanding dynamic schema extraction; and it tracks resource leaks — handles closed, workers terminated, rejections logged not swallowed.

---

## 2. Pre-Release Audit Protocol

**Scope.** Audit the **FULL diff** against the target release branch — not just headline files — tracing each change through its dependency chain from UI down to filesystem and hardware.

**Self-review gate.** Every candidate finding must survive four checks or be discarded: **Cause** (root cause in *this* diff, or pre-existing on base?), **Action** (does the fix compile and match workspace types/idioms? untested hand-written refactors are prohibited), **Reaction** (trace all call sites — does it break consumers or add races, contention, CI lint errors?), **Necessity** (real bug/security/performance issue, or style opinion?).

**Verdict.** `## Verdict: **Ready**` or `**Not Ready**`, plus `Confidence: **[High/Medium/Low]**`, `Mergeable: **[Yes/No]**`, `CI Verification: **[Passing/Failing/Pending]**`.

**Coverage checklist — trace all ten, omit none:**

1. **Merge state:** conflicts; is automated rebase safe?
2. **IPC boundary:** each new/changed `tauri::command` — payload type validation, safe integer bounds (`u64` → JS `Number` precision), array/buffer bounds, discriminated-union results instead of thrown errors.
3. **Lifecycle:** cancellation on unmount, stale-callback rejection via generation counters/tokens, re-entrancy guards on serial ops (keystroke streams), release of handles and hardware streams on teardown.
4. **Persistence:** localStorage / app-config / SQLite — single source of truth (no drifting dual writes), migration safety, `ROLLBACK` on partial failure.
5. **UI logic:** controlled inputs (no uncontrolled→controlled), exhaustive hook dependency arrays, listener teardown, explicit pending/disabled/loading/empty/error states.
6. **UI review:** grid-consistent spacing; WCAG AA contrast and typography; focus rings, modal focus trapping, platform shortcuts (`Cmd` vs `Ctrl`); scoped transitions only (never `transition: all`); theme continuity with no un-themed flash.
7. **Edge cases:** empty arrays / zero-length buffers, `null` vs `undefined` vs missing JSON fields, platform variation (`\r\n`, path layouts), boundary data (silent audio, empty prompts).
8. **Security:** URL scheme validation, Tauri scope limits, `../` traversal and canonicalization guards, webview XSS.
9. **Tests:** untested new behaviors and invariants.
10. **Lint/CI:** `oxlint`, `prettier`, `clippy` clean; no new warnings.

**Report structure.** Seven sections in order: `## Verdict` · `## Major findings` · `## Minor findings` · `## Nitpick findings` · `## UI review findings` · `## Missing important test coverage` · `## What is working correctly`. Findings use **[Severity — Title]**, `File:Line`, then *The Problem:* / *The Solution:* (or *Context:* / *Details:* for the later sections).

---

## 3. Rust (Tauri) Backend

**3.1 Subprocesses.** `wait_with_output()` buffers unbounded output into RAM (OOM); timing out without `kill()` + `wait()` leaks zombies; not draining pipes concurrently deadlocks a chatty child on a full pipe buffer; `Command::new` cannot run CMD builtins (`dir`, `echo`, `ver`). Drain stdout *and* stderr on background threads with a byte cap (keep draining past the cap), keep the `Child` handle and kill+reap on timeout — don't unconditionally join readers afterwards, since descendants may still hold the pipe — and allow-list genuine binaries only.

**3.2 Paths & symlinks.** Validating a relative path against `audio_dir` but passing the *raw* input to `remove_file` resolves against CWD; `.starts_with(audio_dir)` is lexical and loses to `..` and symlinks; an un-canonicalized `audio_dir` makes every comparison silently fail. Canonicalize both the file's parent and the target directory before comparing; reject symlinks at the final component via `symlink_metadata` (while still allowing not-yet-existing destinations); always operate on the canonical `PathBuf` the validator returns, never the raw string.

**3.3 Network streaming.** Use a custom `redirect::Policy` validating host/scheme and capping hops; reject an oversized advertised `Content-Length` up front; enforce the cap again with a per-chunk byte counter and delete the partial file on breach. A missing `Content-Length` is a policy choice — require it for fixed artifacts from hosts you control, allow `None` where chunked/compressed responses are legitimate.

**3.4 Concurrency & tests.** A process-global `CANCEL_TYPING` with no session key lets session A's late cancel abort session B — key cancellation to a session and no-op outside an active one. Cargo runs tests in parallel threads, so mutating shared statics randomly fails other tests: wrap global access in helpers and restore prior values with a `Drop` guard.

**3.5 SQLite.** Tautological table assertions (a hardcoded list vs. its copy) let a new table escape the privacy wipe. Tests should read the live schema (`sqlite_master`), subtract an explicit allow-list (`sqlite_%`, `_sqlx_migrations`), and assert every remaining table is in `USER_DATA_TABLES_TO_CLEAR`. Wrap wipes in `pool.begin()` so a partial failure rolls back.

**3.6 IPC, CORS, CSP.** Keep `remote.urls` restricted to localhost loopbacks — wildcards give any loaded page (docs mirrors included) native command access. External domains stay IPC-free webviews. Keep CSP in `tauri.conf.json` synchronized with production (`script-src 'self'`), and scrub stale comments claiming IPC the config no longer grants.

**3.7 Native pills & geometry.** Offset toplevel coordinates by half the window width/height so Linux/X11 drags match macOS and Windows center anchoring — raw origins make the pill jump monitors. Use inclusive boundary probes and place fallbacks strictly inside the screen (e.g. `max - 1.0`) so the pill is never off-screen.

**3.8 Model cache.** Holding `MODEL_CACHE.lock()` across a whole inference serializes every transcription. Acquire, clone the runtime handle, `drop(cache)`, then run the heavy computation unlocked.

**3.9 ONNX artifacts.** Never `let _ = tokio::spawn(...)` companion downloads (tokenizers, vocabs, configs) — dropped join handles hide failures and leave models silently half-installed. Aggregate the futures and `tokio::try_join!` them before reporting ready. In tests, poll readiness instead of sleeping a fixed duration.

---

## 4. TypeScript & React Frontend

**4.1 Hooks & StrictMode.** Never assign `ref.current` or set state during render — the double render corrupts it. A ref-guarded controller built once (`if (!ref.current) ref.current = new Controller(options)`) freezes later `options` such as `timeoutMs`. Do setup in `useEffect`, and pass dynamic config as call arguments (`controller.run(promise, timeoutMs)`).

**4.2 Async races.** Two overlapping reloads can let the older response overwrite newer data, and state set after unmount leaks. Use a monotonic generation counter in an async controller: increment on each `run()`, and bail out of every completion, error, timeout, and cleanup path whose generation no longer matches. Return a teardown from `useEffect` that increments the generation and clears timers.

**4.3 IPC bindings.** Never hand-edit `bindings.ts` — regenerate via `scripts/bindings.sh` or the cargo build flow after changing `commands.rs`, and register every new command in the builder in `app.rs`.

**4.4 Audio input.** Close or pause microphone streams in `useEffect` cleanup, or handles leak and the OS recording indicator stays lit. Iterate `Float32Array` PCM with built-in array methods or explicit range guards, never unchecked C-style indexing.

**4.5 Default device drop-off.** If the default device's display name fails to resolve, fall back to a placeholder like `"System Default"`; returning `None` strips `is_default` and the UI shows no default mic. Cache and target devices by stable hardware ID instead of re-enumerating by label on every recording toggle.

---

## 5. CI/CD & Monorepo

- **Turbo graph:** `"check-types": { "dependsOn": ["^check-types"] }` yields spurious `TS2307` because dependencies were never built. Depend on `["^build"]`.
- **Least privilege:** verification jobs (format, lint, typecheck, cargo test) get `permissions: contents: read`; write scopes only in publish/release steps.
- **Trigger filters:** desktop `paths` filters must cover everything affecting compilation — `apps/desktop/**`, `packages/**`, `patches/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.github/scripts/install-desktop-linux-deps.sh`.
- **Dependency floors:** keep both bounds in overrides — `"vitest@<3.2.6": ">=3.2.6 <4.0.0"`. Dropping the floor permits a downgrade back into vulnerable `3.x`.
- **Updater trust anchors:** never commit signing keys or `__UPDATER_PUBLIC_KEY__` literals (a fork could sign binaries the app auto-trusts), and never duplicate the literal across CI and setup scripts. Set `"createUpdaterArtifacts": false` publicly and inject `TAURI_UPDATER_PUBLIC_KEY` from repository secrets during the release build only.
- **Platform symmetry:** if `rust_windows_pill` gets `cargo test`, so must `rust_macos_pill` and `rust_gtk_pill` — clippy-only coverage hides runtime bugs. Provision tools (e.g. `imagemagick`) in the platform dependency scripts, not inline installs missing `apt-get update`.
- **Boolean casts:** `"false"` is truthy in Node and Python, so `CI=false` reads as "in CI". Compare explicitly: `process.env.CI === "true"`.

---

## 6. Suggestions & Nitpicks

**Suggestions** (`🟡 Minor` / `🔵 Trivial`) target performance, maintainability, and defensive coding: strip dead variables, imports, and ignored parameters; prefer safe option handling (`unwrap_or_default()`, `if let Some`, `?.`, `??`) over risky unwraps; adopt modern idioms (`std::mem::take`, iterator combinators over C-style loops, `async/await` over `.then` chains); avoid holding a mutex across a nested call that causes micro-contention and render delay.

**Nitpicks** have zero functional impact: formatting drift and trailing whitespace, missing EOF newline, comments contradicting the code (e.g. "throws X" after a rewrite to `Result`), and descriptive renames following monorepo casing (camelCase TS, snake_case Rust).

**Linter boundaries.** Oxlint scans `apps/desktop/src` per `apps/desktop/oxlint.json` via `pnpm --filter desktop run lint` (which also runs a Prettier check); Prettier covers TS/TSX, CSS, and Markdown through the root `format` script; Clippy runs `cargo clippy -- -D warnings` for the Tauri backend and each native pill crate. There is **no ESLint or Markdownlint in CI** — Markdown structure findings are readability nits, not gates. Verify suggestions don't themselves break these checks.

---

## 7. Anti-Pattern Checklist

| Category | Smell | Severity | Remediation |
| :--- | :--- | :--- | :--- |
| Rust security | Raw string path deletion | Critical | Canonicalize; act on returned `PathBuf` |
| Rust security | Unvalidated HTTP redirect | Critical | Policy verifying host, scheme, hop count |
| Rust security | Over-permissive `remote.urls` | Critical | Restrict IPC capability to loopback |
| Rust perf | Subprocess output buffered in RAM | Major | Stream via capped concurrent readers |
| Rust concurrency | Parallel tests mutating statics | Major | Scope access; restore in a `Drop` guard |
| Rust concurrency | Mutex held across async work | Major | Clone under a short lock, drop, then run |
| Rust robustness | Tautological constant tests | Major | Parse the live schema in tests |
| Rust ops | Fire-and-forget companion spawns | Major | Aggregate and await the full artifact set |
| Rust UI | Exclusive max bounds in geometry | Medium | Place strictly within screen bounds |
| React hooks | Writing refs during render | Major | Move into `useEffect` or pure setters |
| React safety | Stale cached controller config | Major | Pass dynamic params per call |
| React lifecycle | State set after unmount | Medium | Generation counter discards stale updates |
| TS hardware | Default input dropped on label scan | Medium | Placeholder label for unnamed defaults |
| TS perf | Label lookups each hardware cycle | Minor | Target cached, stable device IDs |
| CI/CD | Over-privileged `GITHUB_TOKEN` | Medium | `contents: read` on verification jobs |
| Turborepo | Tautological task dependencies | Medium | Depend on `^build` |
| CI security | Committed updater keys | Critical | Inject from secrets at release time |
| CI coverage | Asymmetrical per-platform tests | Major | Symmetrical `cargo test` on all targets |
| Script safety | Env vars cast to boolean | Medium | Explicit string comparison |
| Clean code | Dead variables and imports | Minor | Strip for a clean Oxlint pass |
| Formatting | Missing heading blanks / EOF newline | Nitpick | Normalize Markdown formatting |
| Docs | Comments contradicting signatures | Nitpick | Rewrite docs to match the code |
/home/user/mausVoice/REVIEW.md
# mausVoice Review & Hardening Handbook

Condensed reference for agents and engineers on `mausVoice`: the contracts, security boundaries, and recurring review findings for the Rust (Tauri) backend and React/TypeScript frontend.

---

## 1. Reviewer Personas

**CodeRabbit** audits for correctness, security, edge cases, leaks, and concurrency over style. It traces data flow across the whole PR (React input → IPC → Rust → SQLite/OS APIs) with `ast-grep` and `rg`, and assumes any reachable state will be reached. Findings carry a severity (`🔴 Critical` arbitrary write / injection / crash · `🟠 Major` bugs, leaks, races, unhandled rejections · `🟡 Minor` idioms, docs), a *why* with file:line, a committable diff, and a `<details>` prompt scoping a minimal fix for downstream agents.

**Kilo Code** reviews for precision: code must live up to its own comments (a doc claiming "traversal cannot escape" triggers an audit for real canonicalization; drift is a high-priority bug); it rejects tautological tests asserting a hardcoded constant against its own copy; and it tracks resource leaks — handles closed, workers terminated, rejections logged not swallowed.

---

## 2. Pre-Release Audit Protocol

**Scope.** Audit the **FULL diff** against the target release branch, tracing each change through its dependency chain from UI down to filesystem and hardware.

**Self-review gate.** A finding must survive four checks or be discarded: **Cause** (root cause in *this* diff, or pre-existing?), **Action** (does the fix compile and match workspace idioms? untested hand-written refactors are prohibited), **Reaction** (trace call sites — does it break consumers or add races, contention, lint errors?), **Necessity** (real bug, or style opinion?).

**Verdict.** `## Verdict: **Ready**` or `**Not Ready**`, plus `Confidence: **[High/Medium/Low]**`, `Mergeable: **[Yes/No]**`, `CI Verification: **[Passing/Failing/Pending]**`.

**Coverage checklist — trace all ten, omit none:**

1. **Merge state:** conflicts; is automated rebase safe?
2. **IPC boundary:** each new/changed `tauri::command` — payload type validation, safe integer bounds (`u64` → JS `Number` precision), buffer bounds, discriminated-union results instead of thrown errors.
3. **Lifecycle:** cancellation on unmount, stale-callback rejection via generation counters, re-entrancy guards on serial ops (keystroke streams), release of handles and hardware streams on teardown.
4. **Persistence:** localStorage / app-config / SQLite — single source of truth (no drifting dual writes), migration safety, `ROLLBACK` on partial failure.
5. **UI logic:** controlled inputs, exhaustive hook dependency arrays, listener teardown, explicit pending/disabled/loading/empty/error states.
6. **UI review:** grid-consistent spacing; WCAG AA contrast and typography; focus rings, modal focus trapping, platform shortcuts (`Cmd` vs `Ctrl`); scoped transitions only (never `transition: all`); no un-themed flash.
7. **Edge cases:** empty arrays / zero-length buffers, `null` vs `undefined` vs missing JSON fields, platform variation (`\r\n`, path layouts), boundary data (silent audio, empty prompts).
8. **Security:** URL scheme validation, Tauri scope limits, `../` traversal and canonicalization guards, webview XSS.
9. **Tests:** untested new behaviors and invariants.
10. **Lint/CI:** `oxlint`, `prettier`, `clippy` clean; no new warnings.

**Report structure.** Seven sections in order: `## Verdict` · `## Major findings` · `## Minor findings` · `## Nitpick findings` · `## UI review findings` · `## Missing important test coverage` · `## What is working correctly`. Findings use **[Severity — Title]**, `File:Line`, then *The Problem:* / *The Solution:* (or *Context:* / *Details:* later).

---

## 3. Rust (Tauri) Backend

**Subprocesses.** `wait_with_output()` buffers unbounded output into RAM (OOM); timing out without `kill()` + `wait()` leaks zombies; undrained pipes deadlock a chatty child. Drain stdout *and* stderr on background threads with a byte cap (keep draining past it), keep the `Child` handle and kill+reap on timeout — don't unconditionally join readers afterwards, since descendants may hold the pipe. Allow-list genuine binaries only: `Command::new` cannot run CMD builtins (`dir`, `echo`, `ver`).

**Paths & symlinks.** Validating a relative path against `audio_dir` but passing the *raw* input to `remove_file` resolves against CWD; `.starts_with(audio_dir)` is lexical and loses to `..` and symlinks; an un-canonicalized `audio_dir` makes every comparison silently fail. Canonicalize both the file's parent and the target dir before comparing; reject symlinks at the final component via `symlink_metadata` (while still allowing not-yet-existing destinations); operate on the canonical `PathBuf`, never the raw string.

**Network streaming.** Use a custom `redirect::Policy` validating host/scheme and capping hops; reject an oversized advertised `Content-Length` up front; enforce the cap again with a per-chunk counter and delete the partial file on breach. A missing `Content-Length` is a policy choice — require it for fixed artifacts from hosts you control, allow `None` where chunked/compressed responses are legitimate.

**Concurrency & tests.** A process-global `CANCEL_TYPING` with no session key lets session A's late cancel abort session B — key cancellation to a session and no-op outside an active one. Cargo runs tests in parallel threads, so mutating shared statics randomly fails others: wrap global access in helpers and restore prior values with a `Drop` guard.

**SQLite.** Tautological table assertions (a hardcoded list vs. its copy) let a new table escape the privacy wipe. Tests should read the live schema (`sqlite_master`), subtract an explicit allow-list (`sqlite_%`, `_sqlx_migrations`), and assert every remaining table is in `USER_DATA_TABLES_TO_CLEAR`. Wrap wipes in `pool.begin()` so partial failures roll back.

**IPC, CORS, CSP.** Keep `remote.urls` restricted to localhost loopbacks — wildcards give any loaded page (docs mirrors included) native command access. External domains stay IPC-free webviews. Keep CSP in `tauri.conf.json` synchronized with production (`script-src 'self'`), and scrub stale comments claiming IPC the config no longer grants.

**Native pills & geometry.** Offset toplevel coordinates by half the window width/height so Linux/X11 drags match macOS and Windows center anchoring — raw origins make the pill jump monitors. Use inclusive boundary probes and place fallbacks strictly inside the screen (e.g. `max - 1.0`).

**Model cache.** Holding `MODEL_CACHE.lock()` across a whole inference serializes every transcription. Acquire, clone the runtime handle, `drop(cache)`, then run the heavy computation unlocked.

**ONNX artifacts.** Never `let _ = tokio::spawn(...)` companion downloads (tokenizers, vocabs, configs) — dropped join handles hide failures and leave models half-installed. Aggregate the futures and `tokio::try_join!` them before reporting ready. In tests, poll readiness instead of sleeping a fixed duration.

---

## 4. TypeScript & React Frontend

**Hooks & StrictMode.** Never assign `ref.current` or set state during render — the double render corrupts it. A ref-guarded controller built once (`if (!ref.current) ref.current = new Controller(options)`) freezes later `options` such as `timeoutMs`. Do setup in `useEffect`, and pass dynamic config as call arguments (`controller.run(promise, timeoutMs)`).

**Async races.** Overlapping reloads let an older response overwrite newer data, and state set after unmount leaks. Use a monotonic generation counter: increment on each `run()`, and bail out of every completion, error, timeout, and cleanup path whose generation no longer matches. Return a teardown from `useEffect` that increments the generation and clears timers.

**IPC bindings.** Never hand-edit `bindings.ts` — regenerate via `scripts/bindings.sh` or the cargo build flow after changing `commands.rs`, and register every new command in the builder in `app.rs`.

**Audio input.** Close or pause microphone streams in `useEffect` cleanup, or handles leak and the OS recording indicator stays lit. Iterate `Float32Array` PCM with built-in array methods or explicit range guards, never unchecked indexing.

**Default device drop-off.** If the default device's display name fails to resolve, fall back to a placeholder like `"System Default"`; returning `None` strips `is_default` and the UI shows no default mic. Target devices by stable hardware ID instead of re-enumerating by label on every toggle.

---

## 5. CI/CD & Monorepo

- **Turbo graph:** `"check-types": { "dependsOn": ["^check-types"] }` yields spurious `TS2307` because dependencies were never built. Depend on `["^build"]`.
- **Least privilege:** verification jobs (format, lint, typecheck, cargo test) get `permissions: contents: read`; write scopes only in publish/release steps.
- **Trigger filters:** desktop `paths` filters must cover everything affecting compilation — `apps/desktop/**`, `packages/**`, `patches/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.github/scripts/install-desktop-linux-deps.sh`.
- **Dependency floors:** keep both bounds in overrides — `"vitest@<3.2.6": ">=3.2.6 <4.0.0"`. Dropping the floor permits a downgrade back into vulnerable `3.x`.
- **Updater trust anchors:** never commit signing keys or `__UPDATER_PUBLIC_KEY__` literals (a fork could sign binaries the app auto-trusts), and never duplicate the literal across CI and setup scripts. Set `"createUpdaterArtifacts": false` publicly and inject `TAURI_UPDATER_PUBLIC_KEY` from repository secrets during the release build only.
- **Platform symmetry:** if `rust_windows_pill` gets `cargo test`, so must `rust_macos_pill` and `rust_gtk_pill` — clippy-only coverage hides runtime bugs. Provision tools (e.g. `imagemagick`) in the platform dependency scripts, not inline installs missing `apt-get update`.
- **Boolean casts:** `"false"` is truthy in Node and Python, so `CI=false` reads as "in CI". Compare explicitly: `process.env.CI === "true"`.

---

## 6. Suggestions & Nitpicks

**Suggestions** (`🟡 Minor` / `🔵 Trivial`) target performance and defensive coding: strip dead variables, imports, and ignored parameters; prefer safe option handling (`unwrap_or_default()`, `if let Some`, `?.`, `??`) over risky unwraps; adopt modern idioms (`std::mem::take`, iterator combinators, `async/await` over `.then` chains); avoid holding a mutex across a nested call.

**Nitpicks** have zero functional impact: formatting drift and trailing whitespace, missing EOF newline, comments contradicting the code (e.g. "throws X" after a rewrite to `Result`), and descriptive renames following monorepo casing (camelCase TS, snake_case Rust).

**Linter boundaries.** Oxlint scans `apps/desktop/src` per `apps/desktop/oxlint.json` via `pnpm --filter desktop run lint` (which also runs a Prettier check); Prettier covers TS/TSX, CSS, and Markdown through the root `format` script; Clippy runs `cargo clippy -- -D warnings` for the Tauri backend and each pill crate. There is **no ESLint or Markdownlint in CI** — Markdown structure findings are readability nits, not gates.

---

## 7. Anti-Pattern Checklist

| Category         | Smell                              | Severity | Remediation                               |
| :--------------- | :--------------------------------- | :------- | :---------------------------------------- |
| Rust security    | Raw string path deletion           | Critical | Canonicalize; act on returned `PathBuf`   |
| Rust security    | Unvalidated HTTP redirect          | Critical | Verify host, scheme, hop count            |
| Rust security    | Over-permissive `remote.urls`      | Critical | Restrict IPC capability to loopback       |
| Rust perf        | Subprocess output buffered in RAM  | Major    | Stream via capped concurrent readers      |
| Rust concurrency | Parallel tests mutating statics    | Major    | Scope access; restore in a `Drop` guard   |
| Rust concurrency | Mutex held across async work       | Major    | Clone under a short lock, drop, then run  |
| Rust robustness  | Tautological constant tests        | Major    | Parse the live schema in tests            |
| Rust ops         | Fire-and-forget companion spawns   | Major    | Aggregate and await the full artifact set |
| Rust UI          | Exclusive max bounds in geometry   | Medium   | Place strictly within screen bounds       |
| React hooks      | Writing refs during render         | Major    | Move into `useEffect` or pure setters     |
| React safety     | Stale cached controller config     | Major    | Pass dynamic params per call              |
| React lifecycle  | State set after unmount            | Medium   | Generation counter discards stale updates |
| TS hardware      | Default input dropped on scan      | Medium   | Placeholder label for unnamed defaults    |
| TS perf          | Label lookups each hardware cycle  | Minor    | Target cached, stable device IDs          |
| CI/CD            | Over-privileged `GITHUB_TOKEN`     | Medium   | `contents: read` on verification jobs     |
| Turborepo        | Tautological task dependencies     | Medium   | Depend on `^build`                        |
| CI security      | Committed updater keys             | Critical | Inject from secrets at release time       |
| CI coverage      | Asymmetrical per-platform tests    | Major    | Symmetrical `cargo test` on all targets   |
| Script safety    | Env vars cast to boolean           | Medium   | Explicit string comparison                |
| Clean code       | Dead variables and imports         | Minor    | Strip for a clean Oxlint pass             |
| Formatting       | Missing heading blanks/EOF newline | Nitpick  | Normalize Markdown formatting             |
| Docs             | Comments contradicting signatures  | Nitpick  | Rewrite docs to match the code            |
/home/user/mausVoice/REVIEW.md
# mausVoice Review & Hardening Handbook

Condensed reference for agents and engineers on `mausVoice`: the contracts, security boundaries, and recurring review findings for the Rust (Tauri) backend and React/TypeScript frontend.

---

## 1. Reviewer Personas

**CodeRabbit** audits correctness, security, edge cases, leaks, and concurrency over style. It traces data flow across the whole PR (React input → IPC → Rust → SQLite/OS APIs) and assumes any reachable state will be reached. Findings carry a severity (`🔴 Critical` arbitrary write / injection / crash · `🟠 Major` bugs, leaks, races, unhandled rejections · `🟡 Minor` idioms, docs), a *why* with file:line, a committable diff, and a `<details>` prompt scoping a minimal fix for downstream agents.

**Kilo Code** reviews for precision: code must live up to its own comments (a doc claiming "traversal cannot escape" triggers an audit for real canonicalization; drift is a high-priority bug); it rejects tautological tests asserting a hardcoded constant against its own copy; it tracks resource leaks — handles closed, workers terminated, rejections logged not swallowed.

---

## 2. Pre-Release Audit Protocol

**Scope.** Audit the **FULL diff** against the target release branch, tracing each change from UI down to filesystem and hardware.

**Self-review gate.** A finding must survive four checks or be discarded: **Cause** (root cause in *this* diff, or pre-existing?), **Action** (does the fix compile and match workspace idioms? untested refactors are prohibited), **Reaction** (trace call sites — does it break consumers or add races, contention, lint errors?), **Necessity** (real bug, or style opinion?).

**Verdict.** `## Verdict: **Ready**` or `**Not Ready**`, plus `Confidence: **[High/Medium/Low]**`, `Mergeable: **[Yes/No]**`, `CI Verification: **[Passing/Failing/Pending]**`.

**Coverage checklist — trace all ten, omit none:**

1. **Merge state:** conflicts; is automated rebase safe?
2. **IPC boundary:** each new/changed `tauri::command` — payload validation, safe integer bounds (`u64` → JS `Number` precision), buffer bounds, discriminated-union results instead of thrown errors.
3. **Lifecycle:** cancellation on unmount, stale-callback rejection via generation counters, re-entrancy guards on serial ops, release of handles and hardware streams on teardown.
4. **Persistence:** localStorage / app-config / SQLite — single source of truth (no drifting dual writes), migration safety, `ROLLBACK` on partial failure.
5. **UI logic:** controlled inputs, exhaustive hook dependency arrays, listener teardown, explicit pending/disabled/loading/empty/error states.
6. **UI review:** grid-consistent spacing; WCAG AA contrast; focus rings, modal focus trapping, platform shortcuts (`Cmd` vs `Ctrl`); scoped transitions only (never `transition: all`); no un-themed flash.
7. **Edge cases:** empty arrays / zero-length buffers, `null` vs `undefined` vs missing JSON fields, platform variation (`\r\n`, path layouts), boundary data (silent audio, empty prompts).
8. **Security:** URL scheme validation, Tauri scope limits, `../` traversal and canonicalization guards, webview XSS.
9. **Tests:** untested new behaviors and invariants.
10. **Lint/CI:** `oxlint`, `prettier`, `clippy` clean; no new warnings.

**Report structure.** Seven sections in order: `## Verdict` · `## Major findings` · `## Minor findings` · `## Nitpick findings` · `## UI review findings` · `## Missing important test coverage` · `## What is working correctly`. Findings use **[Severity — Title]**, `File:Line`, then *The Problem:* / *The Solution:* (or *Context:* / *Details:* later).

---

## 3. Rust (Tauri) Backend

**Subprocesses.** `wait_with_output()` buffers unbounded output into RAM (OOM); timing out without `kill()` + `wait()` leaks zombies; undrained pipes deadlock a chatty child. Drain stdout *and* stderr on threads with a byte cap (keep draining past it) and kill+reap on timeout — don't unconditionally join the readers afterwards, since descendants may hold the pipe. Allow-list real binaries only: `Command::new` cannot run CMD builtins (`dir`, `echo`, `ver`).

**Paths & symlinks.** Validating a relative path against `audio_dir` but passing the *raw* input to `remove_file` resolves against CWD; `.starts_with(audio_dir)` is lexical and loses to `..` and symlinks; an un-canonicalized `audio_dir` makes every comparison silently fail. Canonicalize both the file's parent and the target dir before comparing, reject symlinks at the final component via `symlink_metadata` (still allowing not-yet-existing destinations), and operate on the canonical `PathBuf`.

**Network streaming.** Use a custom `redirect::Policy` validating host/scheme and capping hops; reject an oversized advertised `Content-Length` up front; enforce the cap again with a per-chunk counter and delete the partial file on breach. Missing `Content-Length` is a policy choice — require it for fixed artifacts from hosts you control, allow `None` where chunked responses are legitimate.

**Concurrency & tests.** A process-global `CANCEL_TYPING` with no session key lets session A's late cancel abort session B — key cancellation to a session and no-op outside an active one. Cargo runs tests in parallel threads, so mutating shared statics randomly fails others: wrap global access in helpers and restore values with a `Drop` guard.

**SQLite.** Tautological table assertions (a hardcoded list vs. its copy) let a new table escape the privacy wipe. Tests should read the live schema (`sqlite_master`), subtract an explicit allow-list (`sqlite_%`, `_sqlx_migrations`), and assert every remaining table is in `USER_DATA_TABLES_TO_CLEAR`. Wrap wipes in `pool.begin()`.

**IPC, CORS, CSP.** Keep `remote.urls` restricted to localhost loopbacks — wildcards give any loaded page (docs mirrors included) native command access. External domains stay IPC-free webviews. Keep CSP in `tauri.conf.json` synced with production (`script-src 'self'`), and scrub stale comments claiming IPC the config no longer grants.

**Pills & geometry.** Offset toplevel coordinates by half the window width/height so Linux/X11 drags match macOS and Windows center anchoring — raw origins make the pill jump monitors. Use inclusive boundary probes and place fallbacks strictly inside the screen (e.g. `max - 1.0`).

**Model cache.** Holding `MODEL_CACHE.lock()` across a whole inference serializes every transcription. Acquire, clone the runtime handle, `drop(cache)`, then compute unlocked.

**ONNX artifacts.** Never `let _ = tokio::spawn(...)` companion downloads (tokenizers, vocabs, configs) — dropped join handles hide failures and leave models half-installed. Aggregate the futures and `tokio::try_join!` them before reporting ready; in tests, poll readiness instead of a fixed sleep.

---

## 4. TypeScript & React Frontend

**Hooks & StrictMode.** Never assign `ref.current` or set state during render — the double render corrupts it. A ref-guarded controller built once (`if (!ref.current) ref.current = new Controller(options)`) freezes later `options` such as `timeoutMs`. Set up in `useEffect`, and pass dynamic config as call arguments (`controller.run(promise, timeoutMs)`).

**Async races.** Overlapping reloads let an older response overwrite newer data, and state set after unmount leaks. Use a monotonic generation counter: increment on each `run()`, and bail out of every completion, error, timeout, and cleanup path whose generation no longer matches. Return a teardown from `useEffect` that increments the generation and clears timers.

**IPC bindings.** Never hand-edit `bindings.ts` — regenerate via `scripts/bindings.sh` or the cargo build flow after changing `commands.rs`, and register every new command in the builder in `app.rs`.

**Audio input.** Close or pause microphone streams in `useEffect` cleanup, or handles leak and the OS recording indicator stays lit. Iterate `Float32Array` PCM with built-in array methods or range guards, never unchecked indexing.

**Default device drop-off.** If the default device's name fails to resolve, fall back to a placeholder like `"System Default"`; returning `None` strips `is_default` and the UI shows no default mic. Target devices by stable hardware ID rather than re-enumerating by label on every toggle.

---

## 5. CI/CD & Monorepo

- **Turbo graph:** `"check-types": { "dependsOn": ["^check-types"] }` yields spurious `TS2307` because dependencies were never built. Depend on `["^build"]`.
- **Least privilege:** verification jobs (format, lint, typecheck, cargo test) get `permissions: contents: read`; write scopes only in publish/release steps.
- **Trigger filters:** desktop `paths` filters must cover everything affecting compilation — `apps/desktop/**`, `packages/**`, `patches/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.github/scripts/install-desktop-linux-deps.sh`.
- **Dependency floors:** keep both bounds in overrides — `"vitest@<3.2.6": ">=3.2.6 <4.0.0"`. Dropping the floor permits a downgrade into vulnerable `3.x`.
- **Updater trust anchors:** never commit signing keys or `__UPDATER_PUBLIC_KEY__` literals (a fork could sign binaries the app auto-trusts), and never duplicate the literal across CI and setup scripts. Set `"createUpdaterArtifacts": false` publicly and inject `TAURI_UPDATER_PUBLIC_KEY` from repository secrets in the release build only.
- **Platform symmetry:** if `rust_windows_pill` gets `cargo test`, so must `rust_macos_pill` and `rust_gtk_pill` — clippy-only coverage hides runtime bugs. Provision tools (e.g. `imagemagick`) in the platform dependency scripts, not inline installs missing `apt-get update`.
- **Boolean casts:** `"false"` is truthy in Node and Python, so `CI=false` reads as "in CI". Compare explicitly: `process.env.CI === "true"`.

---

## 6. Suggestions & Nitpicks

**Suggestions** (`🟡 Minor` / `🔵 Trivial`) target performance and defensive coding: strip dead variables and imports; prefer safe option handling (`unwrap_or_default()`, `if let Some`, `?.`, `??`) over risky unwraps; adopt modern idioms (`std::mem::take`, iterator combinators, `async/await` over `.then` chains); avoid holding a mutex across a nested call.

**Nitpicks** have zero functional impact: formatting drift and trailing whitespace, missing EOF newline, comments contradicting the code (e.g. "throws X" after a rewrite to `Result`), and descriptive renames following monorepo casing (camelCase TS, snake_case Rust).

**Linter boundaries.** Oxlint scans `apps/desktop/src` per `apps/desktop/oxlint.json` via `pnpm --filter desktop run lint` (which also runs a Prettier check); Prettier covers TS/TSX, CSS, and Markdown through the root `format` script; Clippy runs `cargo clippy -- -D warnings` for the backend and each pill crate. There is **no ESLint or Markdownlint in CI** — Markdown structure findings are readability nits, not gates.

---

## 7. Anti-Pattern Checklist

| Category         | Smell                             | Severity | Remediation                             |
| :--------------- | :-------------------------------- | :------- | :-------------------------------------- |
| Rust security    | Raw string path deletion          | Critical | Canonicalize; act on returned `PathBuf` |
| Rust security    | Unvalidated HTTP redirect         | Critical | Verify host, scheme, hop count          |
| Rust security    | Over-permissive `remote.urls`     | Critical | Restrict IPC to loopback                |
| Rust perf        | Subprocess output buffered in RAM | Major    | Stream via capped concurrent readers    |
| Rust concurrency | Parallel tests mutating statics   | Major    | Scope access; restore in a `Drop` guard |
| Rust concurrency | Mutex held across async work      | Major    | Clone under a short lock, then drop     |
| Rust robustness  | Tautological constant tests       | Major    | Parse the live schema in tests          |
| Rust ops         | Fire-and-forget companion spawns  | Major    | Await the full artifact set             |
| Rust UI          | Exclusive max bounds in geometry  | Medium   | Place strictly within screen bounds     |
| React hooks      | Writing refs during render        | Major    | Move into `useEffect` or pure setters   |
| React safety     | Stale cached controller config    | Major    | Pass dynamic params per call            |
| React lifecycle  | State set after unmount           | Medium   | Generation counter discards stale sets  |
| TS hardware      | Default input dropped on scan     | Medium   | Placeholder label for unnamed defaults  |
| TS perf          | Label lookups each hardware cycle | Minor    | Target cached, stable device IDs        |
| CI/CD            | Over-privileged `GITHUB_TOKEN`    | Medium   | `contents: read` on verification jobs   |
| Turborepo        | Tautological task dependencies    | Medium   | Depend on `^build`                      |
| CI security      | Committed updater keys            | Critical | Inject from secrets at release time     |
| CI coverage      | Asymmetrical per-platform tests   | Major    | `cargo test` on all targets             |
| Script safety    | Env vars cast to boolean          | Medium   | Explicit string comparison              |
| Clean code       | Dead variables and imports        | Minor    | Strip for a clean Oxlint pass           |
| Formatting       | Missing heading blanks / newline  | Nitpick  | Normalize Markdown formatting           |
| Docs             | Comments contradicting signatures | Nitpick  | Rewrite docs to match the code          |
/home/user/mausVoice/REVIEW.md
# mausVoice Review & Hardening Handbook

Condensed reference for agents and engineers on `mausVoice`: contracts, security boundaries, and recurring review findings for the Rust (Tauri) backend and React/TypeScript frontend.

---

## 1. Reviewer Personas

**CodeRabbit** audits correctness, security, edge cases, leaks, and concurrency over style. It traces data flow across the whole PR (React input → IPC → Rust → SQLite/OS APIs) and assumes any reachable state will be reached. Findings carry a severity (`🔴 Critical` arbitrary write / injection / crash · `🟠 Major` bugs, leaks, races, unhandled rejections · `🟡 Minor` idioms, docs), a *why* with file:line, a committable diff, and a `<details>` prompt scoping a minimal fix for downstream agents.

**Kilo Code** reviews for precision: code must live up to its own comments (a doc claiming "traversal cannot escape" triggers an audit for real canonicalization; drift is a high-priority bug); it rejects tautological tests that assert a hardcoded constant against its own copy; it tracks resource leaks — handles closed, workers terminated, rejections logged not swallowed.

---

## 2. Pre-Release Audit Protocol

**Scope.** Audit the **FULL diff** against the target release branch, tracing each change from UI down to filesystem and hardware.

**Self-review gate.** A finding must survive four checks or be discarded: **Cause** (root cause in *this* diff, or pre-existing?), **Action** (does the fix compile and match workspace idioms? untested refactors are prohibited), **Reaction** (trace call sites — does it break consumers or add races, contention, lint errors?), **Necessity** (real bug, or style opinion?).

**Verdict.** `## Verdict: **Ready**` or `**Not Ready**`, plus `Confidence: **[High/Medium/Low]**`, `Mergeable: **[Yes/No]**`, `CI Verification: **[Passing/Failing/Pending]**`.

**Coverage checklist — trace all ten, omit none:**

1. **Merge state:** conflicts; is automated rebase safe?
2. **IPC boundary:** payload validation, safe integer bounds (`u64` → JS `Number`), buffer bounds, discriminated-union results instead of thrown errors.
3. **Lifecycle:** cancel on unmount, reject stale callbacks via generation counters, re-entrancy guards on serial ops, release handles and hardware streams on teardown.
4. **Persistence:** single source of truth across localStorage / app-config / SQLite (no drifting dual writes), migration safety, `ROLLBACK` on partial failure.
5. **UI logic:** controlled inputs, exhaustive hook deps, listener teardown, explicit pending/disabled/loading/empty/error states.
6. **UI review:** grid-consistent spacing; WCAG AA contrast; focus rings, modal focus trapping, platform shortcuts (`Cmd` vs `Ctrl`); scoped transitions only (never `transition: all`); no un-themed flash.
7. **Edge cases:** empty buffers, `null` vs `undefined` vs missing JSON fields, platform variation (`\r\n`, path layouts), boundary data (silent audio, empty prompts).
8. **Security:** URL scheme validation, Tauri scope limits, `../` traversal and canonicalization guards, webview XSS.
9. **Tests:** untested new behaviors and invariants.
10. **Lint/CI:** `oxlint`, `prettier`, `clippy` clean; no new warnings.

**Report structure.** Seven sections in order: `## Verdict` · `## Major findings` · `## Minor findings` · `## Nitpick findings` · `## UI review findings` · `## Missing important test coverage` · `## What is working correctly`. Findings use **[Severity — Title]**, `File:Line`, then *The Problem:* / *The Solution:* (or *Context:* / *Details:* later).

---

## 3. Rust (Tauri) Backend

**Subprocesses.** `wait_with_output()` buffers unbounded output into RAM (OOM); timing out without `kill()` + `wait()` leaks zombies; undrained pipes deadlock a chatty child. Drain stdout *and* stderr on threads with a byte cap (keep draining past it) and kill+reap on timeout — don't unconditionally join readers afterwards, since descendants may hold the pipe. Allow-list real binaries only: `Command::new` cannot run CMD builtins (`dir`, `echo`, `ver`).

**Paths & symlinks.** Validating a relative path against `audio_dir` but passing the *raw* input to `remove_file` resolves against CWD; `.starts_with(audio_dir)` is lexical and loses to `..` and symlinks; an un-canonicalized `audio_dir` makes every comparison silently fail. Canonicalize both the file's parent and the target dir before comparing, reject symlinks at the final component via `symlink_metadata` (still allowing not-yet-existing destinations), and operate on the canonical `PathBuf`.

**Network streaming.** Use a custom `redirect::Policy` validating host/scheme and capping hops; reject an oversized advertised `Content-Length` up front; enforce the cap again with a per-chunk counter and delete the partial file on breach. Missing `Content-Length` is a policy choice — require it for fixed artifacts from hosts you control, allow `None` where chunked responses are legitimate.

**Concurrency & tests.** A process-global `CANCEL_TYPING` with no session key lets session A's late cancel abort session B — key cancellation to a session and no-op outside an active one. Cargo runs tests in parallel threads, so mutating shared statics randomly fails others: wrap global access in helpers and restore values with a `Drop` guard.

**SQLite.** Tautological table assertions (a hardcoded list vs. its copy) let a new table escape the privacy wipe. Tests should read the live schema (`sqlite_master`), subtract an allow-list (`sqlite_%`, `_sqlx_migrations`), and assert every remaining table is in `USER_DATA_TABLES_TO_CLEAR`. Wrap wipes in `pool.begin()`.

**IPC, CORS, CSP.** Restrict `remote.urls` to localhost loopbacks — wildcards give any loaded page (docs mirrors included) native command access. External domains stay IPC-free webviews. Keep CSP in `tauri.conf.json` synced with production (`script-src 'self'`) and scrub stale comments claiming IPC the config no longer grants.

**Pills & geometry.** Offset toplevel coordinates by half the window width/height so Linux/X11 drags match macOS and Windows center anchoring — raw origins make the pill jump monitors. Use inclusive boundary probes and place fallbacks strictly inside the screen (e.g. `max - 1.0`).

**Model cache.** Holding `MODEL_CACHE.lock()` across a whole inference serializes every transcription. Acquire, clone the runtime handle, `drop(cache)`, then compute unlocked.

**ONNX artifacts.** Never `let _ = tokio::spawn(...)` companion downloads (tokenizers, vocabs, configs) — dropped join handles hide failures and leave models half-installed. Aggregate the futures and `tokio::try_join!` them before reporting ready; in tests, poll readiness instead of a fixed sleep.

---

## 4. TypeScript & React Frontend

**Hooks & StrictMode.** Never assign `ref.current` or set state during render — the double render corrupts it. A ref-guarded controller built once (`if (!ref.current) ref.current = new Controller(options)`) freezes later `options` such as `timeoutMs`. Set up in `useEffect` and pass dynamic config as call arguments (`controller.run(promise, timeoutMs)`).

**Async races.** Overlapping reloads let an older response overwrite newer data, and state set after unmount leaks. Use a monotonic generation counter: increment on each `run()`, and bail out of every completion, error, timeout, and cleanup path whose generation no longer matches. Return a teardown from `useEffect` that increments the generation and clears timers.

**IPC bindings.** Never hand-edit `bindings.ts` — regenerate via `scripts/bindings.sh` or the cargo build flow after changing `commands.rs`, and register every new command in the builder in `app.rs`.

**Audio input.** Close or pause microphone streams in `useEffect` cleanup, or handles leak and the OS recording indicator stays lit. Iterate `Float32Array` PCM with built-in array methods or range guards, never unchecked indexing.

**Default device drop-off.** If the default device's name fails to resolve, fall back to a placeholder like `"System Default"`; returning `None` strips `is_default` and the UI shows no default mic. Target devices by stable hardware ID rather than re-enumerating by label on every toggle.

---

## 5. CI/CD & Monorepo

- **Turbo graph:** `"check-types": { "dependsOn": ["^check-types"] }` yields spurious `TS2307` because dependencies were never built. Depend on `["^build"]`.
- **Least privilege:** verification jobs (format, lint, typecheck, cargo test) get `permissions: contents: read`; write scopes only in publish/release steps.
- **Trigger filters:** desktop `paths` filters must cover everything affecting compilation — `apps/desktop/**`, `packages/**`, `patches/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, and the Linux deps script.
- **Dependency floors:** keep both bounds in overrides — `"vitest@<3.2.6": ">=3.2.6 <4.0.0"`. Dropping the floor permits a downgrade into vulnerable `3.x`.
- **Updater trust anchors:** never commit signing keys or `__UPDATER_PUBLIC_KEY__` literals (a fork could sign binaries the app auto-trusts) or duplicate them across CI and setup scripts. Set `"createUpdaterArtifacts": false` publicly and inject `TAURI_UPDATER_PUBLIC_KEY` from secrets in the release build only.
- **Platform symmetry:** if `rust_windows_pill` gets `cargo test`, so must `rust_macos_pill` and `rust_gtk_pill` — clippy-only coverage hides runtime bugs. Provision tools (e.g. `imagemagick`) in the platform dependency scripts, not inline installs missing `apt-get update`.
- **Boolean casts:** `"false"` is truthy in Node and Python, so `CI=false` reads as "in CI". Compare explicitly: `process.env.CI === "true"`.

---

## 6. Suggestions & Nitpicks

**Suggestions** (`🟡 Minor` / `🔵 Trivial`) target performance and defensive coding: strip dead variables and imports; prefer safe option handling (`unwrap_or_default()`, `if let Some`, `?.`, `??`) over risky unwraps; adopt modern idioms (`std::mem::take`, iterator combinators, `async/await` over `.then` chains); avoid holding a mutex across a nested call.

**Nitpicks** have zero functional impact: formatting drift, missing EOF newline, comments contradicting the code (e.g. "throws X" after a rewrite to `Result`), and renames following monorepo casing (camelCase TS, snake_case Rust).

**Linter boundaries.** Oxlint scans `apps/desktop/src` per `apps/desktop/oxlint.json` via `pnpm --filter desktop run lint` (which also runs a Prettier check); Prettier covers TS/TSX, CSS, and Markdown via the root `format` script; Clippy runs `cargo clippy -- -D warnings` for the backend and each pill crate. There is **no ESLint or Markdownlint in CI** — Markdown structure findings are readability nits, not gates.

---

## 7. Anti-Pattern Checklist

| Smell                             | Severity | Remediation                             |
| :-------------------------------- | :------- | :-------------------------------------- |
| Raw string path deletion          | Critical | Canonicalize; act on returned `PathBuf` |
| Unvalidated HTTP redirect         | Critical | Verify host, scheme, hop count          |
| Over-permissive `remote.urls`     | Critical | Restrict IPC to loopback                |
| Committed updater keys            | Critical | Inject from secrets at release time     |
| Subprocess output buffered in RAM | Major    | Stream via capped concurrent readers    |
| Parallel tests mutating statics   | Major    | Scope access; restore in a `Drop` guard |
| Mutex held across async work      | Major    | Clone under a short lock, then drop     |
| Tautological constant tests       | Major    | Parse the live schema in tests          |
| Fire-and-forget companion spawns  | Major    | Await the full artifact set             |
| Writing refs during render        | Major    | Move into `useEffect` or pure setters   |
| Stale cached controller config    | Major    | Pass dynamic params per call            |
| Asymmetrical per-platform tests   | Major    | `cargo test` on all targets             |
| Exclusive max bounds in geometry  | Medium   | Place strictly within screen bounds     |
| State set after unmount           | Medium   | Generation counter discards stale sets  |
| Default input dropped on scan     | Medium   | Placeholder label for unnamed defaults  |
| Over-privileged `GITHUB_TOKEN`    | Medium   | `contents: read` on verification jobs   |
| Tautological task dependencies    | Medium   | Depend on `^build`                      |
| Env vars cast to boolean          | Medium   | Explicit string comparison              |
| Label lookups each hardware cycle | Minor    | Target cached, stable device IDs        |
| Dead variables and imports        | Minor    | Strip for a clean Oxlint pass           |
| Comments contradicting signatures | Nitpick  | Rewrite docs to match the code          |

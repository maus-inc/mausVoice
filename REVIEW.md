# mausVoice review and hardening handbook

Condensed reference for agents and engineers on `mausVoice`: contracts, security boundaries, and recurring review findings for the Rust (Tauri) backend and React/TypeScript frontend.

---

## 1. Reviewer personas

**CodeRabbit** audits correctness, security, edge cases, leaks, and concurrency over style. It traces data flow across the whole PR (React input, IPC, Rust, SQLite/OS APIs) and assumes any reachable state will be reached. Findings carry a severity (`🔴 Critical` arbitrary write / injection / crash, `🟠 Major` bugs / leaks / races / unhandled rejections, `🟡 Minor` idioms / docs), a _why_ with file:line, a committable diff, and a `<details>` prompt scoping a minimal fix for downstream agents.

**Kilo Code** reviews for precision: code must live up to its own comments (a doc claiming "traversal cannot escape" triggers an audit for real canonicalization; drift is a high-priority bug); it rejects tautological tests that assert a hardcoded constant against its own copy; it tracks resource leaks, handles closed, workers terminated, rejections logged not swallowed.

---

## 2. Pre-release audit protocol

**Scope.** Audit the **FULL diff** against the target release branch, tracing each change from UI down to filesystem and hardware.

**Self-review gate.** A finding must survive four checks or be discarded: **Cause** (root cause in _this_ diff, or pre-existing?), **Action** (does the fix compile and match workspace idioms? untested refactors are prohibited), **Reaction** (trace call sites, does it break consumers or add races, contention, lint errors?), **Necessity** (real bug, or style opinion?).

**Verdict.** `## Verdict: **Ready**` or `**Not Ready**`, plus `Confidence: **[High/Medium/Low]**`, `Mergeable: **[Yes/No]**`, `CI Verification: **[Passing/Failing/Pending]**`.

**Coverage checklist. Trace all ten, omit none:**

1. **Merge state:** conflicts; is automated rebase safe?
2. **IPC boundary:** payload validation, safe integer bounds (`u64` to JS `Number`), buffer bounds, discriminated-union results instead of thrown errors.
3. **Lifecycle:** cancel on unmount, reject stale callbacks via generation counters, re-entrancy guards on serial ops, release handles and hardware streams on teardown.
4. **Persistence:** single source of truth across localStorage / app-config / SQLite (no drifting dual writes), migration safety, `ROLLBACK` on partial failure.
5. **UI logic:** controlled inputs, exhaustive hook deps, listener teardown, explicit pending/disabled/loading/empty/error states.
6. **UI review:** grid-consistent spacing; WCAG AA contrast; focus rings, modal focus trapping, platform shortcuts (`Cmd` vs `Ctrl`); scoped transitions only (never `transition: all`); no un-themed flash.
7. **Edge cases:** empty buffers, `null` vs `undefined` vs missing JSON fields, platform variation (`\r\n`, path layouts), boundary data (silent audio, empty prompts).
8. **Security:** URL scheme validation, Tauri scope limits, `../` traversal and canonicalization guards, webview XSS.
9. **Tests:** untested new behaviors and invariants.
10. **Lint/CI:** `oxlint`, `prettier`, `clippy` clean; no new warnings.

**Report structure.** Seven sections in order: `## Verdict`, `## Major findings`, `## Minor findings`, `## Nitpick findings`, `## UI review findings`, `## Missing important test coverage`, `## What is working correctly`. Findings use **[Severity, Title]**, `File:Line`, then _The Problem:_ / _The Solution:_ (or _Context:_ / _Details:_ later).

---

## 3. Rust (Tauri) backend

**Subprocesses.** `wait_with_output()` buffers unbounded output into RAM (OOM); timing out without `kill()` + `wait()` leaks zombies; undrained pipes deadlock a chatty child. Drain stdout _and_ stderr on threads with a byte cap (keep draining past it) and kill+reap on timeout. Do not unconditionally join readers afterwards, since descendants may hold the pipe. Allow-list real binaries only: `Command::new` cannot run CMD builtins (`dir`, `echo`, `ver`).

**Paths and symlinks.** Validating a relative path against `audio_dir` but passing the _raw_ input to `remove_file` resolves against CWD; `.starts_with(audio_dir)` is lexical and loses to `..` and symlinks; an un-canonicalized `audio_dir` makes every comparison silently fail. Canonicalize both the file's parent and the target dir before comparing, reject symlinks at the final component via `symlink_metadata` (still allowing not-yet-existing destinations), and operate on the canonical `PathBuf`.

**Network streaming.** Use a custom `redirect::Policy` validating host/scheme and capping hops; reject an oversized advertised `Content-Length` up front; enforce the cap again with a per-chunk counter and delete the partial file on breach. Missing `Content-Length` is a policy choice. Require it for fixed artifacts from hosts you control, allow `None` where chunked responses are legitimate.

**Concurrency and tests.** A process-global `CANCEL_TYPING` with no session key lets session A's late cancel abort session B. Key cancellation to a session and no-op outside an active one. Cargo runs tests in parallel threads, so mutating shared statics randomly fails others: wrap global access in helpers and restore values with a `Drop` guard.

**SQLite.** Tautological table assertions (a hardcoded list vs. its copy) let a new table escape the privacy wipe. Tests should read the live schema (`sqlite_master`), subtract an allow-list (`sqlite_%`, `_sqlx_migrations`), and assert every remaining table is in `USER_DATA_TABLES_TO_CLEAR`. Wrap wipes in `pool.begin()`.

**IPC, CORS, CSP.** Restrict `remote.urls` to localhost loopbacks. Wildcards give any loaded page (docs mirrors included) native command access. External domains stay IPC-free webviews. Keep CSP in `tauri.conf.json` synced with production (`script-src 'self'`) and scrub stale comments claiming IPC the config no longer grants.

**Pills and geometry.** Offset toplevel coordinates by half the window width/height so Linux/X11 drags match macOS and Windows center anchoring. Raw origins make the pill jump monitors. Use inclusive boundary probes and place fallbacks strictly inside the screen (e.g. `max - 1.0`).

**Model cache.** Holding `MODEL_CACHE.lock()` across a whole inference serializes every transcription. Acquire, clone the runtime handle, `drop(cache)`, then compute unlocked.

**ONNX artifacts.** Never `let _ = tokio::spawn(...)` companion downloads (tokenizers, vocabs, configs). Dropped join handles hide failures and leave models half-installed. Aggregate the futures and `tokio::try_join!` them before reporting ready; in tests, poll readiness instead of a fixed sleep.

---

## 4. TypeScript and React frontend

**Hooks and StrictMode.** Never assign `ref.current` or set state during render. The double render corrupts it. A ref-guarded controller built once (`if (!ref.current) ref.current = new Controller(options)`) freezes later `options` such as `timeoutMs`. Set up in `useEffect` and pass dynamic config as call arguments (`controller.run(promise, timeoutMs)`).

**Async races.** Overlapping reloads let an older response overwrite newer data, and state set after unmount leaks. Use a monotonic generation counter: increment on each `run()`, and bail out of every completion, error, timeout, and cleanup path whose generation no longer matches. Return a teardown from `useEffect` that increments the generation and clears timers.

**IPC bindings.** Never hand-edit `bindings.ts`. Regenerate via `scripts/bindings.sh` or the cargo build flow after changing `commands.rs`, and register every new command in the builder in `app.rs`.

**Audio input.** Close or pause microphone streams in `useEffect` cleanup, or handles leak and the OS recording indicator stays lit. Iterate `Float32Array` PCM with built-in array methods or range guards, never unchecked indexing.

**Default device drop-off.** If the default device's name fails to resolve, fall back to a placeholder like `"System Default"`; returning `None` strips `is_default` and the UI shows no default mic. Target devices by stable hardware ID rather than re-enumerating by label on every toggle.

---

## 5. CI/CD and monorepo

- **Turbo graph:** `"check-types": { "dependsOn": ["^check-types"] }` yields spurious `TS2307` because dependencies were never built. Depend on `["^build"]`.
- **Least privilege:** verification jobs (format, lint, typecheck, cargo test) get `permissions: contents: read`; write scopes only in publish/release steps.
- **Trigger filters:** desktop `paths` filters must cover everything affecting compilation: `apps/desktop/**`, `packages/**`, `patches/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, and the Linux deps script.
- **Dependency floors:** keep both bounds in overrides. Dropping the floor permits a downgrade into vulnerable ranges.
- **Updater trust anchors:** never commit signing keys or `__UPDATER_PUBLIC_KEY__` literals (a fork could sign binaries the app auto-trusts) or duplicate them across CI and setup scripts. Set `"createUpdaterArtifacts": false` publicly and inject `TAURI_UPDATER_PUBLIC_KEY` from secrets in the release build only.
- **Platform symmetry:** if `rust_windows_pill` gets `cargo test`, so must `rust_macos_pill` and `rust_gtk_pill`. Clippy-only coverage hides runtime bugs. Provision tools (e.g. `imagemagick`) in the platform dependency scripts, not inline installs missing `apt-get update`.
- **Boolean casts:** `"false"` is truthy in Node and Python, so `CI=false` reads as "in CI". Compare explicitly: `process.env.CI === "true"`.

---

## 6. Suggestions and nitpicks

**Suggestions** (`🟡 Minor` / `🔵 Trivial`) target performance and defensive coding: strip dead variables and imports; prefer safe option handling (`unwrap_or_default()`, `if let Some`, `?.`, `??`) over risky unwraps; adopt modern idioms (`std::mem::take`, iterator combinators, `async/await` over `.then` chains); avoid holding a mutex across a nested call.

**Nitpicks** have zero functional impact: formatting drift, missing EOF newline, comments contradicting the code (e.g. "throws X" after a rewrite to `Result`), and renames following monorepo casing (camelCase TS, snake_case Rust).

**Linter boundaries.** Oxlint scans `apps/desktop/src` per `apps/desktop/oxlint.json` via `pnpm --filter desktop run lint` (which also runs a Prettier check); Prettier covers TS/TSX, CSS, and Markdown via the root `format` script; Clippy runs `cargo clippy -- -D warnings` for the backend and each pill crate. There is no ESLint or Markdownlint in CI. Markdown structure findings are readability nits, not gates.

---

## 7. Anti-pattern checklist

| Smell | Severity | Remediation |
|:---|:---|:---|
| Raw string path deletion | Critical | Canonicalize; act on returned `PathBuf` |
| Unvalidated HTTP redirect | Critical | Verify host, scheme, hop count |
| Over-permissive `remote.urls` | Critical | Restrict IPC to loopback |
| Committed updater keys | Critical | Inject from secrets at release time |
| Subprocess output buffered in RAM | Major | Stream via capped concurrent readers |
| Parallel tests mutating statics | Major | Scope access; restore in a `Drop` guard |
| Mutex held across async work | Major | Clone under a short lock, then drop |
| Tautological constant tests | Major | Parse the live schema in tests |
| Fire-and-forget companion spawns | Major | Await the full artifact set |
| Writing refs during render | Major | Move into `useEffect` or pure setters |
| Stale cached controller config | Major | Pass dynamic params per call |
| Asymmetrical per-platform tests | Major | `cargo test` on all targets |
| Exclusive max bounds in geometry | Medium | Place strictly within screen bounds |
| State set after unmount | Medium | Generation counter discards stale sets |
| Default input dropped on scan | Medium | Placeholder label for unnamed defaults |
| Over-privileged `GITHUB_TOKEN` | Medium | `contents: read` on verification jobs |
| Tautological task dependencies | Medium | Depend on `^build` |
| Env vars cast to boolean | Medium | Explicit string comparison |
| Label lookups each hardware cycle | Minor | Target cached, stable device IDs |
| Dead variables and imports | Minor | Strip for a clean Oxlint pass |
| Comments contradicting signatures | Nitpick | Rewrite docs to match the code |

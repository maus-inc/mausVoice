# Shared Foundations — Decisions

## Decision 1: Feature flags stored in UserPreferences as a JSON blob

**Choice:** Add a single `expansionFlags` JSON column to `user_preferences`
that holds a map of flag name -> boolean. Read/written through the existing
`LocalUserPreferencesRepo`.

**Rationale:** One column per flag would require a migration per feature. A JSON
blob lets any later PR add a new flag without a schema change. SQLite handles
JSON via `json_extract`.

**Rejected alternatives:**

- Environment variables: not user-toggleable, requires restart.
- Separate `feature_flags` table: over-engineered for a single user profile.

## Decision 2: Redaction utility in `src/utils/redaction.utils.ts`

**Choice:** A small, pure-TS module with `redactString`, `redactError`, and
`redactObject`. No Rust changes needed.

**Rationale:** Redaction happens at the log-call boundary in TypeScript. The
Rust side already avoids logging secrets. Keeping it in TS matches the
"TypeScript is the brain" principle.

## Decision 3: Generic secret storage — future scope

**Choice:** Defer generic named-secret storage to a later expansion PR.

**Rationale:** The crypto primitives in `system/crypto.rs` are already generic,
but adding a `generic_secrets` table and Tauri commands is out of scope for
the shared-foundations PR. Connectors and the local API can add their own
secret storage when those features are implemented.

## Decision 4: Centralize incognito checks behind `isPersistenceAllowed()`

**Choice:** Add `src/utils/incognito.utils.ts` exporting
`isPersistenceAllowed(): boolean`. Replace existing inline checks with calls
to this helper. Behavior is preserved exactly.

**Rationale:** Eliminates duplicated logic, single place to audit incognito
behavior, reduces risk of a new feature forgetting the incognito gate.

**Status:** The two inline checks in `transcribe.actions.ts` and
`remote-transcript.actions.ts` were left reading `incognitoModeEnabled` directly
when this decision was first implemented. Decision 7 completes the migration,
because an ephemeral session has to reach those call sites to suppress anything.

## Decision 5: New domain types in `apps/desktop/src/types/`

**Choice:** Add `meetings.types.ts`, `automation.types.ts`,
`translations.types.ts`, `snippets.types.ts`, `expansion-flags.types.ts` to
`apps/desktop/src/types/`.

**Rationale:** These types are app-specific, not cross-package. Keeping them
in the desktop app avoids rebuilding `packages/types/` and is consistent with
existing app-specific types in the same directory.

## Decision 6: Bind event contracts to payloads through one map

**Choice:** Define the expansion event names and their payload types in
`packages/desktop-utils/src/tauri-events.ts`, then bind them in a single
`ExpansionEventPayloads` map. `apps/desktop/src/hooks/tauri.hooks.ts` exposes
one `useExpansionEventListener(eventName, callback)` hook that reads that map.

**Rationale:** A hook per event means sixteen copies of the same subscription
body, and each copy can drift from the payload type it claims to carry. One map
gives a single place to register an event, and the listener infers the payload
type from the event name at every call site.

**Rejected alternatives:**

- One typed hook per event: duplicates the subscription body sixteen times and
  raises duplication on new code.
- Calling the untyped `useTauriListen(event, callback)` at each site: drops the
  payload contract, so an event name and its payload type can drift apart.

## Decision 7: Ephemeral sessions reuse the flag blob and gate persistence

**Choice:** Store the user preference as the `ephemeralSessionEnabled` entry in
`EXPANSION_FLAG_NAMES`. Track the live session as `ephemeralSessionActive` in
`LocalState`. Extend `isPersistenceAllowed()` in `src/utils/incognito.utils.ts`
so it returns false while incognito mode is on or an ephemeral session is
active. Reset `ephemeralSessionActive` in the store `merge` handler so a session
never survives a restart. Point `storeTranscription` and the remote transcript
store at that helper, because those are the two paths that actually write
transcripts and audio.

**Rationale:** The preference needs no migration, which is the point of
Decision 1. The live session is transient, so it belongs in local state rather
than in `user_preferences`. Suppressing persistence is what makes the session
mean anything, so it shares the one gate that Decision 4 established.

**Rejected alternatives:**

- A dedicated `ephemeral_session_enabled` column: one migration per flag.
- Leaving `isPersistenceAllowed()` reading incognito only: an ephemeral session
  would still write transcripts and audio to disk.
- Leaving `ephemeralSessionActive` in the persisted `local` slice without a
  reset: the zustand persist middleware stores the whole `local` object, so a
  session would come back after a restart with persistence still suppressed and
  no session in progress.

## Decision 8: Extend the Rust log sanitizer next to Decision 2

**Choice:** Add six rules to
`apps/desktop/src-tauri/src/utils/log_sanitizer.rs` for LLM prompts, webhook
payloads, webhook URLs, connector credentials, meeting transcripts, and
translation content.

**Rationale:** Decision 2 keeps `redaction.utils.ts` as the boundary where new
TypeScript code redacts before it logs. The Rust sanitizer is a separate layer
that already scrubs content on its way into a log file. Expansion features write
through both paths, so both layers need the new shapes.

**Rejected alternatives:**

- TypeScript only: native log lines would reach the file unscrubbed.

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

## Decision 3: Generic secret storage via new Tauri command + repo

**Choice:** Add a `generic_secrets` SQLite table with `name, ciphertext, nonce`,
plus `generic_secret_set` / `generic_secret_get` Tauri commands that wrap
`system/crypto.rs`. Expose through a `LocalGenericSecretRepo`.

**Rationale:** The crypto primitives are already generic. This just adds a
typed persistence layer for arbitrary named secrets (webhook tokens, API
credentials, pairing secrets).

**Rejected alternatives:**
- Reuse the API key table: semantically wrong, couples unrelated features.
- OS keychain via Tauri: adds a dependency, inconsistent across platforms.

## Decision 4: Centralize incognito checks behind `isPersistenceAllowed()`

**Choice:** Add `src/utils/incognito.utils.ts` exporting
`isPersistenceAllowed(): boolean`. Replace existing inline checks with calls
to this helper. Behavior is preserved exactly.

**Rationale:** Eliminates duplicated logic, single place to audit incognito
behavior, reduces risk of a new feature forgetting the incognito gate.

## Decision 5: New domain types in `apps/desktop/src/types/`

**Choice:** Add `meetings.types.ts`, `automation.types.ts`,
`translations.types.ts`, `snippets.types.ts`, `expansion-flags.types.ts` to
`apps/desktop/src/types/`.

**Rationale:** These types are app-specific, not cross-package. Keeping them
in the desktop app avoids rebuilding `packages/types/` and is consistent with
existing app-specific types in the same directory.

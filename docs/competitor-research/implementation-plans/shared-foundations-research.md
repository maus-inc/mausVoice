# Shared Foundations — Research

## Falsifiable research questions

1. Does mausVoice currently have a centralized feature-flag mechanism?
2. Where does the codebase currently log potentially sensitive data?
3. Is the existing encrypted secret storage (`system/crypto.rs`) reusable for
   arbitrary named secrets, or only for API keys?
4. How many places gate persistence on incognito mode, and are they consistent?
5. Where should new shared domain types live — `packages/types/` or
   `apps/desktop/src/types/`?

## Findings

### 1. Feature flags

No centralized runtime feature-flag mechanism exists. Feature toggling is done
via:
- Build-time `VITE_FLAVOR` in `src/utils/env.utils.ts` (not user-toggleable).
- Per-feature settings checks scattered across actions and components.
- `isPersonalUseProEnabled()` in `src/utils/personal-use.utils.ts` (always true
  in this build).

### 2. Sensitive data logging

- The Tauri log plugin and Rust `tracing` crate are used for logging.
- Diagnostics export in `src/actions/` already does some manual sanitization.
- No shared redaction helper exists. Some actions log transcript text and
  provider names directly.

### 3. Encrypted secret storage

- `system/crypto.rs` implements XChaCha20-Poly1305 and is used by
  `LocalApiKeyRepo` for API key encryption.
- The crypto primitives are generic (encrypt/decrypt bytes) but the repo layer
  is specific to API keys.
- No generic named-secret storage exists.

### 4. Incognito persistence gating

Found in:
- `src/actions/transcribe.actions.ts` — skips persistence when incognito.
- `src/actions/transcriptions.actions.ts` — same.
- `src/repos/preferences.repo.ts` — `incognitoModeEnabled` preference stored.
- `src/actions/remote-transcript.actions.ts` — incognito check.

The pattern is: read `incognitoModeEnabled` from preferences, skip DB write if
true. Duplicated in each action.

### 5. Domain types location

- `packages/types/` holds shared TS domain models (User, Transcription, ApiKey,
  Tone, etc.). Built as a separate package.
- `apps/desktop/src/types/` holds app-specific types (ai.types.ts,
  state.types.ts, strategy.types.ts).

New expansion types should go in `apps/desktop/src/types/` since they are
app-specific (meetings, automation, translations). The `packages/types/`
package is better for truly cross-package shared types.

## Source references

| Claim | Source |
|-------|--------|
| No centralized feature flags | `src/utils/env.utils.ts` (lines 29-37), manual search |
| Crypto is XChaCha20-Poly1305 | `src-tauri/src/system/crypto.rs` (per AGENTS.md) |
| Incognito duplicated | `src/actions/transcribe.actions.ts`, `src/actions/transcriptions.actions.ts` |
| Types in two locations | `packages/types/src/`, `apps/desktop/src/types/` |

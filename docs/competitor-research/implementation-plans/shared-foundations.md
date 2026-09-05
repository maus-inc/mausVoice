# Shared Foundations — Implementation Plan

**Category:** Feature expansion
**Stack position:** 1 (base expansion branch, parent: PR #144 head)
**Branch:** `expansion/1-shared-foundations`

---

## Goal

Deliver the shared infrastructure that every later expansion feature depends on:
feature flags, privacy-safe logging/redaction, encrypted secret storage reuse,
incognito-mode persistence suppression, and shared domain types plus event
contracts. No user-visible behavior changes outside the new foundations
themselves.

## Non-goals

- Meeting notes, translations, connectors, automation, hands-free toggle, and
  voice workflows. Each has its own later PR.
- Any change to the existing dictation flow, transcription pipeline, or
  post-processing behavior.
- Cloud sync, mobile, or compliance certifications.

---

## Verified competitor behavior (citations)

| Competitor  | Behavior                                                             | Source                                    | Confidence |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------- | ---------- |
| TypeWhisper | Local HTTP API on 127.0.0.1:8978, loopback only, optional auth token | typewhisper.com docs (crawled 2026-08-26) | High       |
| TypeWhisper | CLI talks to the local API                                           | typewhisper.com docs                      | High       |
| Vowen       | MCP server (`vowen mcp`, 23 tools, stdio)                            | docs.vowen.ai                             | High       |
| Wispr Flow  | Read-only MCP server exposing Notetaker data                         | docs.wisprflow.ai                         | High       |
| Vowen       | Webhooks POST with HMAC-SHA256 signing                               | docs.vowen.ai                             | High       |
| TypeWhisper | Webhook post-processor                                               | typewhisper.com docs                      | High       |
| All three   | Incognito/private mode that suppresses persistence                   | vowen.ai, wisprflow.ai, typewhisper.com   | High       |

---

## Current mausVoice behavior

- Feature flags: none centralized. Features are toggled via build-time flavor
  (`src/utils/env.utils.ts`) and per-feature settings checks. No runtime
  feature-flag utility exists.
- Logging: Tauri log plugin + `tracing` on the Rust side. Some manual sanitization
  in diagnostics export (`src/actions/`). No shared redaction helper.
- Encrypted secret storage: `system/crypto.rs` (XChaCha20-Poly1305) used for API
  keys. Reusable but not exposed as a generic secret-storage helper.
- Incognito mode: `incognitoModeEnabled` preference gates persistence in
  multiple places (`transcribe.actions.ts`, `transcriptions.actions.ts`,
  `repos/preferences.repo.ts`). The pattern is duplicated rather than centralized.
- Domain types: `packages/types/` holds shared TS types. No meeting,
  automation, or webhook types exist.

---

## Architecture constraints (from AGENTS.md)

- Rust is the API, TypeScript is the brain. All business logic in TypeScript.
- Single source of truth: Zustand + Immer.
- Data flow: Event -> Action -> Repo -> Tauri command -> native/storage.
- New Tauri commands: define in `commands.rs`, register in `app.rs`, expose via
  Specta, run `pnpm gen:bindings`, wrap in a repo, call from an action.
- Forward-only migrations in `src-tauri/src/db/migrations/`, registered in
  `db/mod.rs`. Never renumber.
- No telemetry, no logging of audio/transcript/prompt/token/secret content.
- No non-loopback network listeners.
- No raw audio in SQLite.

---

## Required migrations

`075_expansion_flags.sql` adds an `expansionFlags` JSON column to
`user_preferences`. The SQLite column name is `expansion_flags` (snake_case);
the Rust domain type and TypeScript `UserPreferences.expansionFlags` use
camelCase. `LocalUserPreferencesRepo.setExpansionFlags()` is the single
write path; `upsert_user_preferences` preserves the existing
`expansion_flags` value on conflict so concurrent preference writers do
not overwrite flag state. Registered in `src-tauri/src/db/mod.rs`.

## Required feature flags

A small runtime feature-flag module under `src/features/` that reads from
`UserPreferences` (persisted in SQLite) so each expansion feature can be
enabled/disabled without a rebuild. Flags added now:

- `meetingNotesEnabled` (default: false)
- `localApiEnabled` (default: false)
- `translationsEnabled` (default: false)
- `connectorsEnabled` (default: false)
- `handsFreeToggleEnabled` (default: false)
- `voiceWorkflowsEnabled` (default: false)

## Privacy-safe logging

A `src/utils/redaction.utils.ts` helper with:

- `redactString(input, mode)` — truncates or hashes strings for logs.
- `redactError(error)` — strips secrets and tokens from
  error messages before they reach any log surface.
- `redactObject(obj, sensitiveKeys)` — redacts known-sensitive keys from a log
  object.

The helper is used by the new local API audit log and by any connector/webhook
logging that follows. Existing logging call sites that currently log transcript
text, provider names, or prompt content must be identified and either removed
or wrapped with the redaction helper before declaring privacy-safe logging
complete.

## Incognito-mode persistence suppression

Centralize the existing scattered incognito checks behind a single
`isPersistenceAllowed()` helper in `src/utils/incognito.utils.ts` that returns
`true` only when incognito mode is off and no ephemeral session is active.
Every path that stores a new transcription calls this helper. The inline checks
in `transcribe.actions.ts` and `remote-transcript.actions.ts` now call it too,
so the invariant lives in one place. `retranscribeTranscription` updates a row
that was already stored under an allowed path, so it needs no gate of its own. Incognito behavior is preserved exactly,
including the separate `incognitoModeIncludeInStats` option, which still counts
words only for incognito mode and never for an ephemeral session. The audio
snapshot guard in `storeTranscription` was removed because the single gate above
it already rules out both modes.

## Shared domain types

Add to `apps/desktop/src/types/`:

- `meetings.types.ts` with `Meeting`, `MeetingSegment`, `MeetingSpeaker`, and
  `MeetingSummary`.
- `automation.types.ts` with `ApiKeyCredential`, `WebhookConfig`, `ApiRequest`,
  and `ApiResponse`.
- `translations.types.ts` with `TranslationRequest` and `TranslationResult`.
- `snippets.types.ts` with `Snippet`, `SnippetVariable`, and
  `SnippetVariableType`.
- `workflows.types.ts` with `Workflow`, `WorkflowAction`, `WorkflowRun`,
  `WorkflowTriggerType`, and `WorkflowStatus`. The `voiceWorkflowsEnabled` flag
  and the three workflow events need these shapes, and no other module defines
  them.
- `expansion-flags.types.ts` with the feature-flag map type.

## Event contracts

`packages/desktop-utils/src/tauri-events.ts` holds sixteen expansion event names
and their payload types for meetings, webhooks, connectors, translations,
workflows, and ephemeral sessions. An `ExpansionEventPayloads` map binds each
name to its payload so the pair cannot drift apart.

`apps/desktop/src/hooks/tauri.hooks.ts` exposes `useExpansionEventListener`,
which infers the payload type from the event name and routes listen and handler
errors to the existing snackbar wrapper. Emitters arrive with each expansion
feature, so a contract can exist here before anything fires it.

## Ephemeral session mode

`ephemeralSessionEnabled` joins `EXPANSION_FLAG_NAMES`, so the preference needs
no migration and is toggled through `setExpansionFlag` in
`src/features/featureFlags.ts`.

`ephemeralSessionActive` in `LocalState` tracks the live session.
`src/actions/ephemeral-session.actions.ts` starts and ends it, broadcasts
`ephemeral_session_started` and `ephemeral_session_ended` so other windows can
react, and ignores a repeat call so the event fires once per transition. The
store `merge` handler resets the field on rehydration because the persist
middleware stores the whole `local` object.

`isPersistenceAllowed()` in `src/utils/incognito.utils.ts` returns false while
incognito mode is on or an ephemeral session is active.

---

## Acceptance criteria

1. Feature flags read from preferences and default to off.
2. Redaction helper covers strings, errors, and objects; unit tests cover each.
3. `isPersistenceAllowed()` returns false when incognito is on or an ephemeral
   session is active; existing incognito behavior is unchanged.
4. Shared domain types compile in `apps/desktop/src/types/`.
5. Event contracts bind each name to its payload through one map, and the typed
   listener infers that payload at the call site.
6. An ephemeral session suppresses persistence, fires its event once per
   transition, and does not survive a restart.
7. No existing dictation, transcription, or post-processing test regresses.
8. Type check, lint, unit tests, and i18n all pass.

---

## Risks, alternatives, unknowns, rejected approaches

- **Risk:** Adding columns to `user_preferences` for flags could collide with
  later PR schema. Mitigation: a single JSON-ish `expansionFlags` blob column
  instead of one column per flag.
- **Alternative:** Use environment variable feature flags. Rejected: requires
  restart, not user-toggleable, breaks local-first principle.
- **Unknown:** Whether the types package is rebuilt fast enough for downstream
  PRs. Mitigation: if slow, types live in `apps/desktop/src/types/` instead.
- **Rejected:** Building the full HTTP API in this PR. Foundations only.

---

## Handoff for next polecat

After this PR is green, the Meeting Notes PR (`expansion/2-meeting-notes`)
can build on:

- `src/features/featureFlags.ts` for the `meetingNotesEnabled` gate.
- `src/utils/incognito.utils.ts` for persistence suppression, which also covers
  an active ephemeral session.
- `apps/desktop/src/types/meetings.types.ts` for domain types.
- `MEETING_STARTED_EVENT`, `MEETING_STOPPED_EVENT`, and
  `MEETING_SUMMARY_GENERATED_EVENT` in
  `packages/desktop-utils/src/tauri-events.ts`, plus their payload types.
- `useExpansionEventListener` in `src/hooks/tauri.hooks.ts` to subscribe with an
  inferred payload.

Still open for later poles:

- Emitters for the fifteen expansion events that nothing fires yet. Ephemeral
  sessions already emit their two.
- Settings UI for the expansion flag toggles, including
  `ephemeralSessionEnabled`.
- A UI indicator for an active ephemeral session.

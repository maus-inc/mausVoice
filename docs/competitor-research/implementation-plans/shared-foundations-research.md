# Shared Foundations Implementation

## Status

Implemented in PR #148 (branch `expansion/shared-foundations`).

## What was built

### 1. Feature Flag System

Centralized feature flags backed by user preferences. All flags default to false and can be toggled at runtime without app restart.

**Files:**

- `packages/types/src/feature-flag.types.ts` — Feature flag union type and state type
- `apps/desktop/src/services/feature-flags.service.ts` — Service for loading, setting, and checking flags
- `apps/desktop/src/state/feature-flags.state.ts` — Initial state (all false)
- `apps/desktop/src/utils/feature-flags.utils.ts` — `isFeatureFlagEnabled()`, `isValidFeatureFlag()`, `getAllFeatureFlags()`

**Flags:** `meetingNotesEnabled`, `localAutomationEnabled`, `connectorsEnabled`, `webhooksEnabled`, `translationsEnabled`, `interactiveSnippetsEnabled`, `handsFreeToggleEnabled`, `voiceWorkflowsEnabled`

### 2. Extended Log Sanitizer

New regex-based redaction rules in `apps/desktop/src-tauri/src/utils/log_sanitizer.rs`:

- LLM prompts (`LLM prompt:`)
- Webhook payloads (`Webhook payload:`)
- Webhook URLs (`Webhook URL:`)
- Connector credentials/tokens (`Connector token:`, `Connector credential:`, etc.)
- Meeting transcripts (`Meeting transcript:`)
- Translation content (`Translation source:`, `Translation result:`)

### 3. Shared Domain Types

New type files in `packages/types/src/`:

- `meeting.types.ts` — Meeting, MeetingSummary, MeetingStatus
- `translation.types.ts` — Translation, TranslationStatus
- `connector.types.ts` — Connector, ConnectorCredential, ConnectorType, ConnectorStatus
- `webhook.types.ts` — Webhook, WebhookDelivery, WebhookDeliveryStatus
- `workflow.types.ts` — Workflow, WorkflowAction, WorkflowRun, WorkflowStatus
- `snippet.types.ts` — InteractiveSnippet, SnippetVariable, SnippetTriggerType

### 4. Event Contracts

New event constants and payload types in `packages/desktop-utils/src/tauri-events.ts`:

- Meeting: `MEETING_STARTED_EVENT`, `MEETING_STOPPED_EVENT`, `MEETING_SUMMARY_GENERATED_EVENT`
- Webhook: `WEBHOOK_DELIVERED_EVENT`, `WEBHOOK_FAILED_EVENT`, `WEBHOOK_RETRY_EVENT`
- Connector: `CONNECTOR_CONNECTED_EVENT`, `CONNECTOR_DISCONNECTED_EVENT`, `CONNECTOR_SYNCED_EVENT`
- Translation: `TRANSLATION_STARTED_EVENT`, `TRANSLATION_COMPLETED_EVENT`
- Workflow: `WORKFLOW_TRIGGERED_EVENT`, `WORKFLOW_COMPLETED_EVENT`, `WORKFLOW_FAILED_EVENT`
- Ephemeral: `EPHEMERAL_SESSION_STARTED_EVENT`, `EPHEMERAL_SESSION_ENDED_EVENT`

Typed listener hooks in `apps/desktop/src/hooks/tauri.hooks.ts`.

### 5. Incognito Mode Extensions

- `ephemeralSessionActive` in `LocalState` (session-scoped, non-persistent)
- `ephemeralSessionEnabled` in `UserPreferences` (persisted preference)
- Actions: `setEphemeralSessionEnabled`, `startEphemeralSession`, `endEphemeralSession`

### 6. Database Migration

Migration `075_feature_flags.sql` adds nine columns to `user_preferences`:

- `meeting_notes_enabled`
- `local_automation_enabled`
- `connectors_enabled`
- `webhooks_enabled`
- `translations_enabled`
- `interactive_snippets_enabled`
- `hands_free_toggle_enabled`
- `voice_workflows_enabled`
- `ephemeral_session_enabled`

Full Rust wiring in domain struct, queries, and migration registry.

## Architecture decisions

- Feature flags are stored as boolean columns on `user_preferences` (not a separate table) to leverage the existing preferences repo and Tauri command infrastructure.
- Ephemeral session state is split: `ephemeralSessionActive` in local (non-persistent) state for runtime UI indicators, `ephemeralSessionEnabled` in persisted preferences for user preference.
- Event contracts are defined as string constants with associated payload types, following the existing `KEYS_HELD_EVENT` pattern.
- Domain types are plain TypeScript types with no runtime code, following the existing `packages/types/src/` pattern.

## Remaining work

- Expansion category implementations (meeting notes, connectors, webhooks, translations, workflows, snippets) will build on these foundations.
- Tauri commands for emitting the new events from Rust will be added when the native event sources are implemented.
- UI for feature flag toggles in settings.
- UI indicators for ephemeral session mode.

/**
 * Tauri event contract shared between the native Rust side and any webview
 * that wants to observe desktop key input. Keep these in sync with the
 * emitters in `mausvoice/apps/desktop/src-tauri/src/commands.rs` (and related).
 */

/** Emitted continuously by the native key listener while keys are held. */
export const KEYS_HELD_EVENT = "keys_held";

/**
 * Emitted once when a native bridge fires a registered hotkey action. The
 * payload carries the action name, not a key combo.
 */
export const BRIDGE_HOTKEY_TRIGGER_EVENT = "bridge_hotkey_trigger";

export type KeysHeldPayload = {
  keys: string[];
};

export type BridgeHotkeyTriggerPayload = {
  hotkey: string;
};

/**
 * Expansion event contracts. Emitters land with each expansion feature, so a
 * name can exist here before anything fires it. Listeners bind through
 * `ExpansionEventPayloads` rather than pairing a name with a payload by hand.
 */

export const MEETING_STARTED_EVENT = "meeting_started";
export const MEETING_STOPPED_EVENT = "meeting_stopped";
export const MEETING_SUMMARY_GENERATED_EVENT = "meeting_summary_generated";

export const WEBHOOK_DELIVERED_EVENT = "webhook_delivered";
export const WEBHOOK_FAILED_EVENT = "webhook_failed";
export const WEBHOOK_RETRY_EVENT = "webhook_retry";

export const CONNECTOR_CONNECTED_EVENT = "connector_connected";
export const CONNECTOR_DISCONNECTED_EVENT = "connector_disconnected";
export const CONNECTOR_SYNCED_EVENT = "connector_synced";

export const TRANSLATION_STARTED_EVENT = "translation_started";
export const TRANSLATION_COMPLETED_EVENT = "translation_completed";

export const WORKFLOW_TRIGGERED_EVENT = "workflow_triggered";
export const WORKFLOW_COMPLETED_EVENT = "workflow_completed";
export const WORKFLOW_FAILED_EVENT = "workflow_failed";

export const EPHEMERAL_SESSION_STARTED_EVENT = "ephemeral_session_started";
export const EPHEMERAL_SESSION_ENDED_EVENT = "ephemeral_session_ended";

export type MeetingStartedPayload = {
  meetingId: string;
  startedAt: string;
};

export type MeetingStoppedPayload = {
  meetingId: string;
  endedAt: string;
  durationMs: number;
};

export type MeetingSummaryGeneratedPayload = {
  meetingId: string;
  summaryId: string;
};

export type WebhookDeliveredPayload = {
  webhookId: string;
  deliveryId: string;
  eventType: string;
};

export type WebhookFailedPayload = {
  webhookId: string;
  deliveryId: string;
  eventType: string;
  errorMessage: string;
};

export type WebhookRetryPayload = {
  webhookId: string;
  deliveryId: string;
  attempt: number;
};

export type ConnectorConnectedPayload = {
  connectorId: string;
  connectorType: string;
};

export type ConnectorDisconnectedPayload = {
  connectorId: string;
  connectorType: string;
};

export type ConnectorSyncedPayload = {
  connectorId: string;
  syncedAt: string;
};

export type TranslationStartedPayload = {
  translationId: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslationCompletedPayload = {
  translationId: string;
  translatedText: string;
};

export type WorkflowTriggeredPayload = {
  workflowId: string;
  runId: string;
  triggerType: string;
};

export type WorkflowCompletedPayload = {
  workflowId: string;
  runId: string;
  completedAt: string;
};

export type WorkflowFailedPayload = {
  workflowId: string;
  runId: string;
  errorMessage: string;
};

export type EphemeralSessionStartedPayload = {
  startedAt: string;
};

export type EphemeralSessionEndedPayload = {
  endedAt: string;
};

/**
 * Binds every expansion event name to its payload type. Adding an event means
 * adding one entry here, and every listener call site then infers the payload.
 */
export type ExpansionEventPayloads = {
  [MEETING_STARTED_EVENT]: MeetingStartedPayload;
  [MEETING_STOPPED_EVENT]: MeetingStoppedPayload;
  [MEETING_SUMMARY_GENERATED_EVENT]: MeetingSummaryGeneratedPayload;
  [WEBHOOK_DELIVERED_EVENT]: WebhookDeliveredPayload;
  [WEBHOOK_FAILED_EVENT]: WebhookFailedPayload;
  [WEBHOOK_RETRY_EVENT]: WebhookRetryPayload;
  [CONNECTOR_CONNECTED_EVENT]: ConnectorConnectedPayload;
  [CONNECTOR_DISCONNECTED_EVENT]: ConnectorDisconnectedPayload;
  [CONNECTOR_SYNCED_EVENT]: ConnectorSyncedPayload;
  [TRANSLATION_STARTED_EVENT]: TranslationStartedPayload;
  [TRANSLATION_COMPLETED_EVENT]: TranslationCompletedPayload;
  [WORKFLOW_TRIGGERED_EVENT]: WorkflowTriggeredPayload;
  [WORKFLOW_COMPLETED_EVENT]: WorkflowCompletedPayload;
  [WORKFLOW_FAILED_EVENT]: WorkflowFailedPayload;
  [EPHEMERAL_SESSION_STARTED_EVENT]: EphemeralSessionStartedPayload;
  [EPHEMERAL_SESSION_ENDED_EVENT]: EphemeralSessionEndedPayload;
};

export type ExpansionEventName = keyof ExpansionEventPayloads;

import {
  useTauriListen as useTauriListenBase,
  type UseTauriListenOptions,
} from "@maus-inc/desktop-utils";
import {
  CONNECTOR_CONNECTED_EVENT,
  CONNECTOR_DISCONNECTED_EVENT,
  CONNECTOR_SYNCED_EVENT,
  EPHEMERAL_SESSION_ENDED_EVENT,
  EPHEMERAL_SESSION_STARTED_EVENT,
  MEETING_STARTED_EVENT,
  MEETING_STOPPED_EVENT,
  MEETING_SUMMARY_GENERATED_EVENT,
  TRANSLATION_COMPLETED_EVENT,
  TRANSLATION_STARTED_EVENT,
  WEBHOOK_DELIVERED_EVENT,
  WEBHOOK_FAILED_EVENT,
  WEBHOOK_RETRY_EVENT,
  WORKFLOW_COMPLETED_EVENT,
  WORKFLOW_FAILED_EVENT,
  WORKFLOW_TRIGGERED_EVENT,
  type ConnectorConnectedPayload,
  type ConnectorDisconnectedPayload,
  type ConnectorSyncedPayload,
  type EphemeralSessionEndedPayload,
  type EphemeralSessionStartedPayload,
  type MeetingStartedPayload,
  type MeetingStoppedPayload,
  type MeetingSummaryGeneratedPayload,
  type TranslationCompletedPayload,
  type TranslationStartedPayload,
  type WebhookDeliveredPayload,
  type WebhookFailedPayload,
  type WebhookRetryPayload,
  type WorkflowCompletedPayload,
  type WorkflowFailedPayload,
  type WorkflowTriggeredPayload,
} from "@maus-inc/desktop-utils";
import { showErrorSnackbar } from "../actions/app.actions";

const surfaceError = (error: unknown) => showErrorSnackbar(error);

/**
 * Desktop-app wrapper around the shared `useTauriListen` hook that routes
 * handler/listen errors to the in-app snackbar instead of the default
 * `console.error` fallback.
 */
export const useTauriListen = <T = unknown>(
  eventName: string,
  callback: (event: T) => void | Promise<void>,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<T>(eventName, callback, {
    ...options,
    onError: surfaceError,
  });
};

export const useMeetingStartedListener = (
  callback: (payload: MeetingStartedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<MeetingStartedPayload>(MEETING_STARTED_EVENT, callback, {
    ...options,
    onError: surfaceError,
  });
};

export const useMeetingStoppedListener = (
  callback: (payload: MeetingStoppedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<MeetingStoppedPayload>(MEETING_STOPPED_EVENT, callback, {
    ...options,
    onError: surfaceError,
  });
};

export const useMeetingSummaryGeneratedListener = (
  callback: (payload: MeetingSummaryGeneratedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<MeetingSummaryGeneratedPayload>(
    MEETING_SUMMARY_GENERATED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useWebhookDeliveredListener = (
  callback: (payload: WebhookDeliveredPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<WebhookDeliveredPayload>(
    WEBHOOK_DELIVERED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useWebhookFailedListener = (
  callback: (payload: WebhookFailedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<WebhookFailedPayload>(WEBHOOK_FAILED_EVENT, callback, {
    ...options,
    onError: surfaceError,
  });
};

export const useWebhookRetryListener = (
  callback: (payload: WebhookRetryPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<WebhookRetryPayload>(WEBHOOK_RETRY_EVENT, callback, {
    ...options,
    onError: surfaceError,
  });
};

export const useConnectorConnectedListener = (
  callback: (payload: ConnectorConnectedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<ConnectorConnectedPayload>(
    CONNECTOR_CONNECTED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useConnectorDisconnectedListener = (
  callback: (payload: ConnectorDisconnectedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<ConnectorDisconnectedPayload>(
    CONNECTOR_DISCONNECTED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useConnectorSyncedListener = (
  callback: (payload: ConnectorSyncedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<ConnectorSyncedPayload>(CONNECTOR_SYNCED_EVENT, callback, {
    ...options,
    onError: surfaceError,
  });
};

export const useTranslationStartedListener = (
  callback: (payload: TranslationStartedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<TranslationStartedPayload>(
    TRANSLATION_STARTED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useTranslationCompletedListener = (
  callback: (payload: TranslationCompletedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<TranslationCompletedPayload>(
    TRANSLATION_COMPLETED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useWorkflowTriggeredListener = (
  callback: (payload: WorkflowTriggeredPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<WorkflowTriggeredPayload>(
    WORKFLOW_TRIGGERED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useWorkflowCompletedListener = (
  callback: (payload: WorkflowCompletedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<WorkflowCompletedPayload>(
    WORKFLOW_COMPLETED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useWorkflowFailedListener = (
  callback: (payload: WorkflowFailedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<WorkflowFailedPayload>(WORKFLOW_FAILED_EVENT, callback, {
    ...options,
    onError: surfaceError,
  });
};

export const useEphemeralSessionStartedListener = (
  callback: (payload: EphemeralSessionStartedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<EphemeralSessionStartedPayload>(
    EPHEMERAL_SESSION_STARTED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

export const useEphemeralSessionEndedListener = (
  callback: (payload: EphemeralSessionEndedPayload) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<EphemeralSessionEndedPayload>(
    EPHEMERAL_SESSION_ENDED_EVENT,
    callback,
    {
      ...options,
      onError: surfaceError,
    },
  );
};

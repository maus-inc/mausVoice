export type ApiAuthMode = "none" | "token";

export type ApiToken = {
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
};

export type WebhookEvent =
  "transcription.completed" | "meeting.completed" | "snippet.expanded";

export type WebhookConfig = {
  id: string;
  url: string;
  events: WebhookEvent[];
  secretName: string;
  enabled: boolean;
  createdAt: string;
};

export type WebhookDeliveryStatus =
  "pending" | "delivered" | "failed" | "retrying";

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  payload: unknown;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  createdAt: string;
};

export type ConnectorType = "obsidian" | "notion" | "slack";

export type ConnectorConfig = {
  id: string;
  type: ConnectorType;
  enabled: boolean;
  secretName: string;
  settings: Record<string, unknown>;
};

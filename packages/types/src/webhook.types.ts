export type WebhookDeliveryStatus =
  "pending" | "delivered" | "failed" | "retrying";

export type Webhook = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  url: string;
  secret: string | null;
  active: boolean;
  eventTypes: string[];
  isDeleted: boolean;
};

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  eventType: string;
  payload: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  errorMessage: string | null;
  createdAt: string;
};

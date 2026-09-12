import { invoke } from "@tauri-apps/api/core";
import type {
  WebhookConfig,
  WebhookDelivery,
  WebhookEvent,
} from "../types/automation.types";
import { BaseRepo } from "./base.repo";

type LocalWebhook = {
  id: string;
  url: string;
  events: string;
  secretSalt: string | null;
  secretCiphertext: string | null;
  enabled: boolean;
  createdAt: number;
};

type LocalWebhookDelivery = {
  id: string;
  webhookId: string;
  event: string;
  payload: string;
  status: string;
  attempts: number;
  lastAttemptAt: number | null;
  createdAt: number;
};

const fromLocalWebhook = (local: LocalWebhook): WebhookConfig => ({
  id: local.id,
  url: local.url,
  events: JSON.parse(local.events) as WebhookEvent[],
  secretName: "",
  enabled: local.enabled,
  createdAt: new Date(local.createdAt).toISOString(),
});

export type CreateWebhookParams = {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret?: string | null;
  enabled: boolean;
};

export abstract class BaseWebhookRepo extends BaseRepo {
  abstract createWebhook(params: CreateWebhookParams): Promise<WebhookConfig>;
  abstract listWebhooks(): Promise<WebhookConfig[]>;
  abstract deleteWebhook(id: string): Promise<void>;
  abstract emitEvent(event: WebhookEvent, payload: unknown): Promise<void>;
}

export class LocalWebhookRepo extends BaseWebhookRepo {
  async createWebhook(params: CreateWebhookParams): Promise<WebhookConfig> {
    const created = await invoke<LocalWebhook>("webhook_create", {
      args: {
        id: params.id,
        url: params.url,
        events: params.events,
        secret: params.secret ?? null,
        enabled: params.enabled,
      },
    });
    return fromLocalWebhook(created);
  }

  async listWebhooks(): Promise<WebhookConfig[]> {
    const stored = await invoke<LocalWebhook[]>("webhook_list");
    return stored.map(fromLocalWebhook);
  }

  async deleteWebhook(id: string): Promise<void> {
    await invoke<void>("webhook_delete", { id });
  }

  async emitEvent(event: WebhookEvent, payload: unknown): Promise<void> {
    await invoke<void>("webhook_emit", { event, payload });
  }
}

export const deliveryFromLocal = (
  local: LocalWebhookDelivery,
): WebhookDelivery => ({
  id: local.id,
  webhookId: local.webhookId,
  event: local.event as WebhookEvent,
  payload: local.payload,
  status: local.status as WebhookDelivery["status"],
  attempts: local.attempts,
  lastAttemptAt:
    local.lastAttemptAt === null
      ? undefined
      : new Date(local.lastAttemptAt).toISOString(),
  createdAt: new Date(local.createdAt).toISOString(),
});

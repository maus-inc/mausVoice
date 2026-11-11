import { ApiKey, ApiKeyProvider, OpenRouterConfig } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

type LocalApiKey = {
  id: string;
  name: string;
  provider: ApiKeyProvider;
  createdAt: number;
  keySuffix?: string | null;
  keyFull?: string | null;
  transcriptionModel?: string | null;
  postProcessingModel?: string | null;
  openRouterConfig?: string | null;
  baseUrl?: string | null;
  azureRegion?: string | null;
  includeV1Path?: boolean | null;
  transcriptionPath?: string | null;
};

const parseOpenRouterConfig = (
  configStr: string | null | undefined,
): OpenRouterConfig | null => {
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as OpenRouterConfig;
  } catch {
    return null;
  }
};

const fromLocalApiKey = (apiKey: LocalApiKey): ApiKey => ({
  id: apiKey.id,
  name: apiKey.name,
  provider: apiKey.provider,
  createdAt: dayjs(apiKey.createdAt).toISOString(),
  keySuffix: apiKey.keySuffix ?? null,
  keyFull: apiKey.keyFull ?? null,
  transcriptionModel: apiKey.transcriptionModel ?? null,
  postProcessingModel: apiKey.postProcessingModel ?? null,
  openRouterConfig: parseOpenRouterConfig(apiKey.openRouterConfig),
  baseUrl: apiKey.baseUrl ?? null,
  azureRegion: apiKey.azureRegion ?? null,
  includeV1Path: apiKey.includeV1Path ?? null,
  transcriptionPath: apiKey.transcriptionPath ?? null,
});

export type CreateApiKeyPayload = {
  id: string;
  name: string;
  provider: ApiKeyProvider;
  key: string;
  baseUrl?: string;
  azureRegion?: string;
  includeV1Path?: boolean;
  transcriptionPath?: string;
};

export type UpdateApiKeyPayload = {
  id: string;
  name?: string;
  key?: string;
  transcriptionModel?: string | null;
  postProcessingModel?: string | null;
  openRouterConfig?: OpenRouterConfig | null;
  baseUrl?: string | null;
  azureRegion?: string | null;
  includeV1Path?: boolean | null;
  transcriptionPath?: string | null;
  clearTranscriptionPath?: boolean | null;
};

export abstract class BaseApiKeyRepo extends BaseRepo {
  abstract listApiKeys(): Promise<ApiKey[]>;
  abstract createApiKey(
    payload: CreateApiKeyPayload,
    lease?: LocalDataWriteLease,
  ): Promise<ApiKey>;
  abstract updateApiKey(
    payload: UpdateApiKeyPayload,
    lease?: LocalDataWriteLease,
  ): Promise<ApiKey>;
  abstract deleteApiKey(id: string, lease?: LocalDataWriteLease): Promise<void>;
}

export class LocalApiKeyRepo extends BaseApiKeyRepo {
  async listApiKeys(): Promise<ApiKey[]> {
    const apiKeys = await invoke<LocalApiKey[]>("api_key_list");
    return apiKeys.map(fromLocalApiKey);
  }

  createApiKey(
    payload: CreateApiKeyPayload,
    lease?: LocalDataWriteLease,
  ): Promise<ApiKey> {
    return withLocalDataWrite(async () => {
      const created = await invoke<LocalApiKey>("api_key_create", {
        apiKey: payload,
      });
      return fromLocalApiKey(created);
    }, lease);
  }

  updateApiKey(
    payload: UpdateApiKeyPayload,
    lease?: LocalDataWriteLease,
  ): Promise<ApiKey> {
    return withLocalDataWrite(async () => {
      const clearTranscriptionPath =
        payload.clearTranscriptionPath ??
        (payload.transcriptionPath === null ? true : undefined);
      const request = {
        ...payload,
        clearTranscriptionPath,
        openRouterConfig:
          payload.openRouterConfig !== undefined
            ? payload.openRouterConfig
              ? JSON.stringify(payload.openRouterConfig)
              : null
            : undefined,
      };
      const updated = await invoke<LocalApiKey>("api_key_update", { request });
      return fromLocalApiKey(updated);
    }, lease);
  }

  deleteApiKey(id: string, lease?: LocalDataWriteLease): Promise<void> {
    return withLocalDataWrite(
      () => invoke<void>("api_key_delete", { id }),
      lease,
    );
  }
}

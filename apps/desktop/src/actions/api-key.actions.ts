import { ApiKey } from "@maus-inc/types";
import dayjs from "dayjs";
import { getApiKeyRepo } from "../repos";
import type {
  CreateApiKeyPayload,
  UpdateApiKeyPayload,
} from "../repos/api-key.repo";
import { getAppState, produceAppState } from "../store";
import { registerApiKeys } from "../utils/app.utils";
import {
  getLocalDataClearGeneration,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { showErrorSnackbar } from "./app.actions";
import { updateUserPreferences } from "./user.actions";
import { refreshVoquillMigrationStatusIfActive } from "./voquill-migration-refresh";

let loadApiKeysPromise: Promise<void> | null = null;
let loadApiKeysGeneration = 0;

const sortApiKeys = (apiKeys: ApiKey[]): ApiKey[] =>
  [...apiKeys].sort(
    (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
  );

export const loadApiKeys = async (options?: {
  force?: boolean;
}): Promise<void> => {
  const force = options?.force === true;
  const status = getAppState().settings.apiKeysStatus;

  if (!force && loadApiKeysPromise) {
    return loadApiKeysPromise;
  }

  if (!force && (status === "loading" || status === "success")) {
    return;
  }

  loadApiKeysGeneration += 1;
  const generation = loadApiKeysGeneration;
  const clearGeneration = getLocalDataClearGeneration();
  const isCurrentLoad = () =>
    generation === loadApiKeysGeneration &&
    clearGeneration === getLocalDataClearGeneration();

  produceAppState((draft) => {
    draft.settings.apiKeysStatus = "loading";
  });

  const activePromise = getApiKeyRepo()
    .listApiKeys()
    .then((apiKeys) => {
      if (!isCurrentLoad()) {
        return;
      }
      produceAppState((draft) => {
        registerApiKeys(draft, apiKeys);
        draft.settings.apiKeys = sortApiKeys(apiKeys);
        draft.settings.apiKeysStatus = "success";
      });
    })
    .catch((error) => {
      if (!isCurrentLoad()) {
        return;
      }
      console.error("Failed to load API keys", error);
      produceAppState((draft) => {
        draft.settings.apiKeysStatus = "error";
      });
      showErrorSnackbar("Failed to load API keys. Please try again.");
    })
    .finally(() => {
      if (loadApiKeysPromise === activePromise) {
        loadApiKeysPromise = null;
        if (getAppState().settings.apiKeysStatus === "loading") {
          produceAppState((draft) => {
            if (draft.settings.apiKeysStatus === "loading") {
              draft.settings.apiKeysStatus = "idle";
            }
          });
        }
      }
    });

  loadApiKeysPromise = activePromise;
  return activePromise;
};

export const createApiKey = async (
  payload: CreateApiKeyPayload,
): Promise<ApiKey> =>
  withLocalDataWrite(async (lease) => {
    try {
      const created = await getApiKeyRepo().createApiKey(payload, lease);

      produceAppState((draft) => {
        registerApiKeys(draft, [created]);
        const merged = draft.settings.apiKeys.filter(
          (apiKey) => apiKey.id !== created.id,
        );
        merged.unshift(created);
        draft.settings.apiKeys = sortApiKeys(merged);
        draft.settings.apiKeysStatus = "success";
      }, lease);

      void refreshVoquillMigrationStatusIfActive();
      return created;
    } catch (error) {
      console.error("Failed to create API key", error);
      showErrorSnackbar(
        error instanceof Error ? error.message : "Failed to save API key.",
      );
      throw error;
    }
  });

export const deleteApiKey = async (id: string): Promise<void> =>
  withLocalDataWrite(async (lease) => {
    let deletedFromRepo = false;
    try {
      await getApiKeyRepo().deleteApiKey(id, lease);
      deletedFromRepo = true;

      produceAppState((draft) => {
        delete draft.apiKeyById[id];
        draft.settings.apiKeys = draft.settings.apiKeys.filter(
          (apiKey) => apiKey.id !== id,
        );
        if (draft.settings.aiTranscription.selectedApiKeyId === id) {
          draft.settings.aiTranscription.selectedApiKeyId = null;
          draft.settings.aiTranscription.mode = null;
        }
        if (draft.settings.aiPostProcessing.selectedApiKeyId === id) {
          draft.settings.aiPostProcessing.selectedApiKeyId = null;
          draft.settings.aiPostProcessing.mode = null;
        }
      }, lease);

      const state = getAppState();
      await updateUserPreferences(
        (preferences) => {
          preferences.transcriptionMode = state.settings.aiTranscription.mode;
          preferences.transcriptionApiKeyId =
            state.settings.aiTranscription.selectedApiKeyId ?? null;
          preferences.postProcessingMode = state.settings.aiPostProcessing.mode;
          preferences.postProcessingApiKeyId =
            state.settings.aiPostProcessing.selectedApiKeyId ?? null;
        },
        undefined,
        { existingLease: lease },
      );
    } catch (error) {
      console.error("Failed to delete API key", error);
      showErrorSnackbar(
        error instanceof Error ? error.message : "Failed to delete API key.",
      );
      throw error;
    } finally {
      if (deletedFromRepo) {
        void refreshVoquillMigrationStatusIfActive();
      }
    }
  });

export const updateApiKey = async (
  payload: UpdateApiKeyPayload,
): Promise<ApiKey> =>
  withLocalDataWrite(async (lease) => {
    try {
      const updated = await getApiKeyRepo().updateApiKey(payload, lease);

      produceAppState((draft) => {
        draft.apiKeyById[updated.id] = updated;
        const index = draft.settings.apiKeys.findIndex(
          (key) => key.id === updated.id,
        );
        if (index !== -1) {
          draft.settings.apiKeys[index] = updated;
        }
      }, lease);

      void refreshVoquillMigrationStatusIfActive();
      return updated;
    } catch (error) {
      console.error("Failed to update API key", error);
      showErrorSnackbar(
        error instanceof Error ? error.message : "Failed to update API key.",
      );
      throw error;
    }
  });

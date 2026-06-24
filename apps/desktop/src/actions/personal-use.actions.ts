import { invoke } from "@tauri-apps/api/core";
import type { ApiKey } from "@voquill/types";
import { createApiKey, loadApiKeys, updateApiKey } from "./api-key.actions";
import { updateUserPreferences } from "./user.actions";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  PERSONAL_GROQ_API_KEY_ID,
  PERSONAL_GROQ_API_KEY_NAME,
  PERSONAL_GROQ_POST_PROCESSING_MODEL,
  PERSONAL_GROQ_TRANSCRIPTION_MODEL,
  isPersonalUseEnabled,
} from "../utils/personal-use.utils";

const PREVIOUS_PERSONAL_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";

const readPersonalGroqApiKey = async (): Promise<string | null> => {
  try {
    return await invoke<string | null>("read_personal_groq_api_key");
  } catch (error) {
    getLogger().warning(`Unable to read personal Groq API key: ${error}`);
    return null;
  }
};

const getPersonalGroqApiKey = (): ApiKey | null => {
  const state = getAppState();
  return (
    state.settings.apiKeys.find(
      (apiKey) => apiKey.id === PERSONAL_GROQ_API_KEY_ID,
    ) ??
    state.settings.apiKeys.find(
      (apiKey) =>
        apiKey.provider === "groq" &&
        apiKey.name.trim() === PERSONAL_GROQ_API_KEY_NAME,
    ) ??
    null
  );
};

const upsertPersonalGroqApiKey = async (
  configuredKey: string,
): Promise<ApiKey> => {
  await loadApiKeys();
  const existing = getPersonalGroqApiKey();

  if (!existing) {
    const created = await createApiKey({
      id: PERSONAL_GROQ_API_KEY_ID,
      name: PERSONAL_GROQ_API_KEY_NAME,
      provider: "groq",
      key: configuredKey,
    });

    return updateApiKey({
      id: created.id,
      transcriptionModel: PERSONAL_GROQ_TRANSCRIPTION_MODEL,
      postProcessingModel: PERSONAL_GROQ_POST_PROCESSING_MODEL,
    });
  }

  const updatePayload: Parameters<typeof updateApiKey>[0] = {
    id: existing.id,
  };
  if (existing.name !== PERSONAL_GROQ_API_KEY_NAME) {
    updatePayload.name = PERSONAL_GROQ_API_KEY_NAME;
  }
  if (existing.keyFull !== configuredKey) {
    updatePayload.key = configuredKey;
  }
  if (
    !existing.transcriptionModel ||
    existing.transcriptionModel === PREVIOUS_PERSONAL_GROQ_TRANSCRIPTION_MODEL
  ) {
    updatePayload.transcriptionModel = PERSONAL_GROQ_TRANSCRIPTION_MODEL;
  }
  if (!existing.postProcessingModel) {
    updatePayload.postProcessingModel = PERSONAL_GROQ_POST_PROCESSING_MODEL;
  }

  if (Object.keys(updatePayload).length === 1) {
    return existing;
  }

  return updateApiKey(updatePayload);
};

const applyPersonalGroqPreferences = async (
  apiKey: ApiKey,
  { force }: { force: boolean },
): Promise<void> => {
  const prefs = getAppState().userPrefs;
  const shouldSetTranscription = force
    ? !prefs?.transcriptionMode ||
      prefs.transcriptionMode === "local" ||
      prefs.transcriptionMode === "cloud" ||
      prefs.transcriptionApiKeyId !== apiKey.id
    : !prefs?.transcriptionMode || prefs.transcriptionMode === "cloud";
  const shouldSetPostProcessing = force
    ? !prefs?.postProcessingMode ||
      prefs.postProcessingMode === "cloud" ||
      prefs.postProcessingApiKeyId !== apiKey.id
    : !prefs?.postProcessingMode || prefs.postProcessingMode === "cloud";
  const shouldSetAgent = force
    ? !prefs?.agentMode ||
      prefs.agentMode === "cloud" ||
      prefs.agentModeApiKeyId !== apiKey.id
    : !prefs?.agentMode || prefs.agentMode === "cloud";

  if (!shouldSetTranscription && !shouldSetPostProcessing && !shouldSetAgent) {
    return;
  }

  await updateUserPreferences((preferences) => {
    if (shouldSetTranscription) {
      preferences.transcriptionMode = "api";
      preferences.transcriptionApiKeyId = apiKey.id;
    }
    if (shouldSetPostProcessing) {
      preferences.postProcessingMode = "api";
      preferences.postProcessingApiKeyId = apiKey.id;
    }
    if (shouldSetAgent) {
      preferences.agentMode = "api";
      preferences.agentModeApiKeyId = apiKey.id;
    }
  });

  getLogger().info("Personal Groq defaults configured");
};

const ensurePersonalGroqApiKey = async (): Promise<ApiKey | null> => {
  const configuredKey = await readPersonalGroqApiKey();
  await loadApiKeys();
  const existing = getPersonalGroqApiKey();

  if (!configuredKey) {
    return existing;
  }

  return upsertPersonalGroqApiKey(configuredKey);
};

export const savePersonalGroqApiKey = async (key: string): Promise<ApiKey> => {
  const apiKey = await upsertPersonalGroqApiKey(key.trim());
  await applyPersonalGroqPreferences(apiKey, { force: true });
  return apiKey;
};

export const configurePersonalGroqDefaults = async (): Promise<void> => {
  if (!isPersonalUseEnabled()) {
    return;
  }

  const apiKey = await ensurePersonalGroqApiKey();
  if (!apiKey) {
    return;
  }

  await applyPersonalGroqPreferences(apiKey, { force: false });
};

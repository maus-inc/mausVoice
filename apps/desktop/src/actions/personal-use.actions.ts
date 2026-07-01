import type { ApiKey } from "@voquill/types";
import { createApiKey, loadApiKeys, updateApiKey } from "./api-key.actions";
import { updateUserPreferences } from "./user.actions";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  PERSONAL_DEEPGRAM_API_KEY_ID,
  PERSONAL_DEEPGRAM_API_KEY_NAME,
  PERSONAL_GROQ_API_KEY_ID,
  PERSONAL_GROQ_API_KEY_NAME,
  PERSONAL_GROQ_POST_PROCESSING_MODEL,
  PERSONAL_GROQ_TRANSCRIPTION_MODEL,
  isPersonalUseEnabled,
  resolvePersonalTranscriptionTarget,
} from "../utils/personal-use.utils";

const PREVIOUS_PERSONAL_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";

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

const getPersonalDeepgramApiKey = (): ApiKey | null => {
  const state = getAppState();
  return (
    state.settings.apiKeys.find(
      (apiKey) => apiKey.id === PERSONAL_DEEPGRAM_API_KEY_ID,
    ) ??
    state.settings.apiKeys.find(
      (apiKey) =>
        apiKey.provider === "deepgram" &&
        apiKey.name.trim() === PERSONAL_DEEPGRAM_API_KEY_NAME,
    ) ??
    null
  );
};

const upsertPersonalDeepgramApiKey = async (
  configuredKey: string,
): Promise<ApiKey> => {
  await loadApiKeys();
  const existing = getPersonalDeepgramApiKey();

  if (!existing) {
    return createApiKey({
      id: PERSONAL_DEEPGRAM_API_KEY_ID,
      name: PERSONAL_DEEPGRAM_API_KEY_NAME,
      provider: "deepgram",
      key: configuredKey,
    });
  }

  const updatePayload: Parameters<typeof updateApiKey>[0] = {
    id: existing.id,
  };
  if (existing.name !== PERSONAL_DEEPGRAM_API_KEY_NAME) {
    updatePayload.name = PERSONAL_DEEPGRAM_API_KEY_NAME;
  }
  if (existing.keyFull !== configuredKey) {
    updatePayload.key = configuredKey;
  }

  if (Object.keys(updatePayload).length === 1) {
    return existing;
  }

  return updateApiKey(updatePayload);
};

// Post-processing + agent default to the personal Groq key. Only changed when
// currently unset/cloud or already pointing at an owned Groq key; an unrelated
// user-selected key is preserved.
const applyPersonalGenerationDefaults = async (
  groqApiKey: ApiKey,
): Promise<void> => {
  const prefs = getAppState().userPrefs;
  const ownedGroqIds = [PERSONAL_GROQ_API_KEY_ID, groqApiKey.id];

  const isOwnedOrUnset = (
    mode: string | null | undefined,
    apiKeyId: string | null | undefined,
  ): boolean =>
    !mode || mode === "cloud" || !apiKeyId || ownedGroqIds.includes(apiKeyId);

  const alreadyGroq = (
    mode: string | null | undefined,
    apiKeyId: string | null | undefined,
  ): boolean => mode === "api" && apiKeyId === groqApiKey.id;

  const shouldSetPostProcessing =
    isOwnedOrUnset(prefs?.postProcessingMode, prefs?.postProcessingApiKeyId) &&
    !alreadyGroq(prefs?.postProcessingMode, prefs?.postProcessingApiKeyId);
  const shouldSetAgent =
    isOwnedOrUnset(prefs?.agentMode, prefs?.agentModeApiKeyId) &&
    !alreadyGroq(prefs?.agentMode, prefs?.agentModeApiKeyId);

  if (!shouldSetPostProcessing && !shouldSetAgent) {
    return;
  }

  await updateUserPreferences((preferences) => {
    if (shouldSetPostProcessing) {
      preferences.postProcessingMode = "api";
      preferences.postProcessingApiKeyId = groqApiKey.id;
    }
    if (shouldSetAgent) {
      preferences.agentMode = "api";
      preferences.agentModeApiKeyId = groqApiKey.id;
    }
  });

  getLogger().info("Personal generation defaults configured");
};

// Transcription prefers the personal Deepgram key (live streaming) over Groq
// (batch). The resolver decides whether a change is allowed; null means leave
// the user's selection untouched.
const applyPersonalTranscriptionDefault = async (
  deepgramKeyId: string | null,
  groqKeyId: string | null,
): Promise<void> => {
  const prefs = getAppState().userPrefs;
  const target = resolvePersonalTranscriptionTarget({
    deepgramKeyId,
    groqKeyId,
    currentMode: prefs?.transcriptionMode ?? null,
    currentApiKeyId: prefs?.transcriptionApiKeyId ?? null,
  });

  if (!target) {
    return;
  }

  await updateUserPreferences((preferences) => {
    preferences.transcriptionMode = target.mode;
    preferences.transcriptionApiKeyId = target.apiKeyId;
  });

  getLogger().info("Personal transcription default configured");
};

export const savePersonalGroqApiKey = async (key: string): Promise<ApiKey> => {
  const groqApiKey = await upsertPersonalGroqApiKey(key.trim());
  await applyPersonalGenerationDefaults(groqApiKey);
  const deepgramApiKey = getPersonalDeepgramApiKey();
  await applyPersonalTranscriptionDefault(
    deepgramApiKey?.id ?? null,
    groqApiKey.id,
  );
  return groqApiKey;
};

export const savePersonalDeepgramApiKey = async (
  key: string,
): Promise<ApiKey> => {
  const deepgramApiKey = await upsertPersonalDeepgramApiKey(key.trim());
  const groqApiKey = getPersonalGroqApiKey();
  await applyPersonalTranscriptionDefault(
    deepgramApiKey.id,
    groqApiKey?.id ?? null,
  );
  return deepgramApiKey;
};

// Applies the personal-use selection defaults from the locally stored keys
// (entered via onboarding / Settings). Keys are never read from the
// environment; this only points transcription/post-processing at the keys the
// user has already configured.
export const configurePersonalDefaults = async (): Promise<void> => {
  if (!isPersonalUseEnabled()) {
    return;
  }

  await loadApiKeys();
  const groqApiKey = getPersonalGroqApiKey();
  const deepgramApiKey = getPersonalDeepgramApiKey();

  if (!groqApiKey && !deepgramApiKey) {
    return;
  }

  await applyPersonalTranscriptionDefault(
    deepgramApiKey?.id ?? null,
    groqApiKey?.id ?? null,
  );

  if (groqApiKey) {
    await applyPersonalGenerationDefaults(groqApiKey);
  }
};

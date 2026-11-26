import type { ApiKey } from "@maus-inc/types";
import { createApiKey, loadApiKeys, updateApiKey } from "./api-key.actions";
import { updateUserPreferences } from "./user.actions";
import { getAppState } from "../store";
import { isApiKeyUsable } from "../utils/api-key.utils";
import { getLogger } from "../utils/log.utils";
import {
  PERSONAL_DEEPGRAM_API_KEY_ID,
  PERSONAL_DEEPGRAM_API_KEY_NAME,
  PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
  PERSONAL_GROQ_API_KEY_ID,
  PERSONAL_GROQ_API_KEY_NAME,
  PERSONAL_GROQ_POST_PROCESSING_MODEL,
  PERSONAL_GROQ_TRANSCRIPTION_MODEL,
  buildPersonalGroqKeyUpdate,
  findPersonalApiKey,
  isPersonalUseEnabled,
  resolvePersonalTranscriptionTarget,
} from "../utils/personal-use.utils";

const getPersonalGroqApiKey = (): ApiKey | null =>
  findPersonalApiKey(getAppState().settings.apiKeys, "groq");

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

  const updatePayload = buildPersonalGroqKeyUpdate(existing, configuredKey);

  // Only the id came back, so the stored key already matches what was
  // configured and there is nothing to write.
  if (Object.keys(updatePayload).length === 1) {
    return existing;
  }

  return updateApiKey(updatePayload);
};

const getPersonalDeepgramApiKey = (): ApiKey | null =>
  findPersonalApiKey(getAppState().settings.apiKeys, "deepgram");

const upsertPersonalDeepgramApiKey = async (
  configuredKey: string,
): Promise<ApiKey> => {
  await loadApiKeys();
  const existing = getPersonalDeepgramApiKey();

  if (!existing) {
    const created = await createApiKey({
      id: PERSONAL_DEEPGRAM_API_KEY_ID,
      name: PERSONAL_DEEPGRAM_API_KEY_NAME,
      provider: "deepgram",
      key: configuredKey,
    });

    return updateApiKey({
      id: created.id,
      transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  }

  const updatePayload: Parameters<typeof updateApiKey>[0] = {
    id: existing.id,
  };
  if (existing.name !== PERSONAL_DEEPGRAM_API_KEY_NAME) {
    updatePayload.name = PERSONAL_DEEPGRAM_API_KEY_NAME;
  }
  if (!isApiKeyUsable(existing) || existing.keyFull !== configuredKey) {
    updatePayload.key = configuredKey;
  }
  // Backfills keys created before the preset existed, which left the model
  // picker empty. A model the user picked themselves is left alone.
  if (!existing.transcriptionModel) {
    updatePayload.transcriptionModel = PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL;
  }

  if (Object.keys(updatePayload).length === 1) {
    return existing;
  }

  return updateApiKey(updatePayload);
};

// Post-processing + agent default to the personal Groq key. Only changed when
// currently unset or already pointing at an owned Groq key; an unrelated
// user-selected key is preserved.
const applyPersonalGenerationDefaults = async (
  groqApiKey: ApiKey,
): Promise<void> => {
  const prefs = getAppState().userPrefs;
  const ownedGroqIds = new Set([PERSONAL_GROQ_API_KEY_ID, groqApiKey.id]);

  const isOwnedOrUnset = (
    mode: string | null | undefined,
    apiKeyId: string | null | undefined,
  ): boolean => !mode || !apiKeyId || ownedGroqIds.has(apiKeyId);

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
// the user's selection untouched. Ownership IDs include unusable personal keys
// (e.g. an imported Personal Groq key needing re-entry) so saving a usable
// personal key still upgrades transcription away from the unusable one while
// keeping unrelated user selections protected.
const applyPersonalTranscriptionDefault = async (
  deepgramKeyId: string | null,
  groqKeyId: string | null,
  ownedPersonalKeyIds: readonly (string | null | undefined)[] = [],
): Promise<void> => {
  const prefs = getAppState().userPrefs;
  const target = resolvePersonalTranscriptionTarget({
    deepgramKeyId,
    groqKeyId,
    ownedPersonalKeyIds,
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
  const usableDeepgramId = isApiKeyUsable(deepgramApiKey)
    ? (deepgramApiKey?.id ?? null)
    : null;
  await applyPersonalTranscriptionDefault(usableDeepgramId, groqApiKey.id, [
    deepgramApiKey?.id,
    groqApiKey.id,
  ]);
  return groqApiKey;
};

export const savePersonalDeepgramApiKey = async (
  key: string,
): Promise<ApiKey> => {
  const deepgramApiKey = await upsertPersonalDeepgramApiKey(key.trim());
  const groqApiKey = getPersonalGroqApiKey();
  const usableGroqId = isApiKeyUsable(groqApiKey)
    ? (groqApiKey?.id ?? null)
    : null;
  await applyPersonalTranscriptionDefault(deepgramApiKey.id, usableGroqId, [
    deepgramApiKey.id,
    groqApiKey?.id,
  ]);
  return deepgramApiKey;
};

// Applies the personal-use selection defaults from the locally stored keys
// (entered via onboarding / Settings). Keys are never read from the
// environment; this only points transcription/post-processing at usable keys
// the user has already configured. Unreadable migrated keys are skipped until
// re-entered.
export const configurePersonalDefaults = async (): Promise<void> => {
  if (!isPersonalUseEnabled()) {
    return;
  }

  await loadApiKeys();
  const rawGroqApiKey = getPersonalGroqApiKey();
  const rawDeepgramApiKey = getPersonalDeepgramApiKey();
  const groqApiKey = isApiKeyUsable(rawGroqApiKey) ? rawGroqApiKey : null;
  const deepgramApiKey = isApiKeyUsable(rawDeepgramApiKey)
    ? rawDeepgramApiKey
    : null;

  if (!groqApiKey && !deepgramApiKey) {
    return;
  }

  await applyPersonalTranscriptionDefault(
    deepgramApiKey?.id ?? null,
    groqApiKey?.id ?? null,
    [rawDeepgramApiKey?.id, rawGroqApiKey?.id],
  );

  if (groqApiKey) {
    await applyPersonalGenerationDefaults(groqApiKey);
  }

  // Backfill here as well as on save. Keys created before the Deepgram preset
  // existed carry no transcription model, and this is the only path that runs
  // for an already-configured install, so without it those users keep an empty
  // model picker until they manually re-enter the key.
  if (deepgramApiKey && !deepgramApiKey.transcriptionModel) {
    await updateApiKey({
      id: deepgramApiKey.id,
      transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  }
};

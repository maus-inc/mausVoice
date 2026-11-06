import { DEEPGRAM_TRANSCRIPTION_MODELS } from "@maus-inc/voice-ai";
import type { ApiKey } from "@maus-inc/types";
import type { UpdateApiKeyPayload } from "../repos/api-key.repo";
import type { TranscriptionMode } from "../types/ai.types";

export const PERSONAL_GROQ_API_KEY_ID = "personal-groq";
export const PERSONAL_GROQ_API_KEY_NAME = "Personal Groq";
export const PERSONAL_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
export const PERSONAL_GROQ_POST_PROCESSING_MODEL = "openai/gpt-oss-20b";

export const PERSONAL_DEEPGRAM_API_KEY_ID = "personal-deepgram";
export const PERSONAL_DEEPGRAM_API_KEY_NAME = "Personal Deepgram";
// Derived from the provider's own model list so the preset cannot drift from
// what DeepgramModelProviderRepo will offer in the model picker.
export const PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL =
  DEEPGRAM_TRANSCRIPTION_MODELS[0];
export const PERSONAL_USER_ID = "local-user-id";
export const PERSONAL_USER_EMAIL = "personal@mausvoice.local";
export const PERSONAL_USER_DISPLAY_NAME = "Personal User";

/**
 * The stored personal key for a provider, matched by id first and by name
 * second, because keys created before the ids above existed carry the name
 * only. One selector so the settings page, the key dialog and the actions
 * cannot disagree about which key counts as the personal one.
 */
export const findPersonalApiKey = (
  apiKeys: readonly ApiKey[],
  provider: "groq" | "deepgram",
): ApiKey | null => {
  const id =
    provider === "groq"
      ? PERSONAL_GROQ_API_KEY_ID
      : PERSONAL_DEEPGRAM_API_KEY_ID;
  const name =
    provider === "groq"
      ? PERSONAL_GROQ_API_KEY_NAME
      : PERSONAL_DEEPGRAM_API_KEY_NAME;

  return (
    apiKeys.find((apiKey) => apiKey.id === id) ??
    apiKeys.find(
      (apiKey) => apiKey.provider === provider && apiKey.name.trim() === name,
    ) ??
    null
  );
};

/**
 * The Groq transcription model this app wrote before it moved to the turbo
 * model. An existing key still pointing at it is a preset, not a choice, so
 * configuring the key again is allowed to move it forward.
 */
export const PREVIOUS_PERSONAL_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";

/**
 * The update an existing personal Groq key needs to match a freshly configured
 * key: only the fields that differ, so re-saving the same key is a no-op rather
 * than a write, and a model someone pinned deliberately is left alone.
 *
 * Pure, so the rules can be read and tested without a store or a database.
 */
export const buildPersonalGroqKeyUpdate = (
  existing: ApiKey,
  configuredKey: string,
): UpdateApiKeyPayload => {
  const update: UpdateApiKeyPayload = { id: existing.id };

  if (existing.name !== PERSONAL_GROQ_API_KEY_NAME) {
    update.name = PERSONAL_GROQ_API_KEY_NAME;
  }
  if (existing.keyFull !== configuredKey) {
    update.key = configuredKey;
  }
  if (
    !existing.transcriptionModel ||
    existing.transcriptionModel === PREVIOUS_PERSONAL_GROQ_TRANSCRIPTION_MODEL
  ) {
    update.transcriptionModel = PERSONAL_GROQ_TRANSCRIPTION_MODEL;
  }
  if (!existing.postProcessingModel) {
    update.postProcessingModel = PERSONAL_GROQ_POST_PROCESSING_MODEL;
  }

  return update;
};

export const isPersonalUseProEnabled = (): boolean => true;

export const isPersonalUseEnabled = (): boolean => isPersonalUseProEnabled();

type PersonalTranscriptionTargetArgs = {
  deepgramKeyId: string | null;
  groqKeyId: string | null;
  currentMode: TranscriptionMode | null;
  currentApiKeyId: string | null;
};

/**
 * Decides which personal API key transcription should point at. Deepgram (live
 * streaming) is preferred over Groq (batch). Returns null when no change should
 * be made: when no personal key exists, when the desired key is already
 * selected, or when the user has explicitly selected an unrelated key.
 */
export const resolvePersonalTranscriptionTarget = ({
  deepgramKeyId,
  groqKeyId,
  currentMode,
  currentApiKeyId,
}: PersonalTranscriptionTargetArgs): {
  mode: "api";
  apiKeyId: string;
} | null => {
  const desiredKeyId = deepgramKeyId ?? groqKeyId;
  if (!desiredKeyId) {
    return null;
  }

  const ownedKeyIds = [
    PERSONAL_GROQ_API_KEY_ID,
    PERSONAL_DEEPGRAM_API_KEY_ID,
    groqKeyId,
    deepgramKeyId,
  ].filter((id): id is string => id !== null);

  const isOwnedOrUnset =
    currentMode === null ||
    currentMode === "local" ||
    currentApiKeyId === null ||
    ownedKeyIds.includes(currentApiKeyId);

  if (!isOwnedOrUnset) {
    return null;
  }

  if (currentMode === "api" && currentApiKeyId === desiredKeyId) {
    return null;
  }

  return { mode: "api", apiKeyId: desiredKeyId };
};

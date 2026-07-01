import type { TranscriptionMode } from "../types/ai.types";
import { getIsEnterpriseEnabled } from "./enterprise.utils";
import { isEnterpriseFlavor } from "./env.utils";

export const PERSONAL_GROQ_API_KEY_ID = "personal-groq";
export const PERSONAL_GROQ_API_KEY_NAME = "Personal Groq";
export const PERSONAL_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
export const PERSONAL_GROQ_POST_PROCESSING_MODEL = "openai/gpt-oss-20b";

export const PERSONAL_DEEPGRAM_API_KEY_ID = "personal-deepgram";
export const PERSONAL_DEEPGRAM_API_KEY_NAME = "Personal Deepgram";
export const PERSONAL_USER_ID = "local-user-id";
export const PERSONAL_USER_EMAIL = "personal@voquill.local";
export const PERSONAL_USER_DISPLAY_NAME = "Personal User";

export const isPersonalUseProEnabled = (): boolean => true;

export const isPersonalUseEnabled = (): boolean =>
  isPersonalUseProEnabled() &&
  !isEnterpriseFlavor() &&
  !getIsEnterpriseEnabled();

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
    currentMode === "cloud" ||
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

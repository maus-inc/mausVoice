import { getIsEnterpriseEnabled } from "./enterprise.utils";
import { isEnterpriseFlavor } from "./env.utils";

export const PERSONAL_GROQ_API_KEY_ID = "personal-groq";
export const PERSONAL_GROQ_API_KEY_NAME = "Personal Groq";
export const PERSONAL_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
export const PERSONAL_GROQ_POST_PROCESSING_MODEL = "openai/gpt-oss-20b";
export const PERSONAL_USER_ID = "local-user-id";
export const PERSONAL_USER_EMAIL = "personal@voquill.local";
export const PERSONAL_USER_DISPLAY_NAME = "Personal User";

export const isPersonalUseProEnabled = (): boolean => true;

export const isPersonalUseEnabled = (): boolean =>
  isPersonalUseProEnabled() &&
  !isEnterpriseFlavor() &&
  !getIsEnterpriseEnabled();

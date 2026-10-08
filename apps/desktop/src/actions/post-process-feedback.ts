import { defineMessage } from "react-intl";
import { getIntl } from "../i18n/intl";
import type { ToastAction } from "../types/toast.types";
import { postProcessErrorReason } from "./post-process-error-category";

export type PostProcessFeedbackContext =
  "dictation" | "history-retranscription" | "history-details" | "audio-import";

export type PostProcessFeedbackAction = "fix" | "history";

export const getPostProcessFeedbackToastAction = (
  action: PostProcessFeedbackAction,
): ToastAction =>
  action === "fix" ? "open_post_processing_settings" : "open_transcriptions";

export type PostProcessFeedback = {
  kind: "local-fallback" | "failed" | "unusable-response";
  severity: "info" | "error";
  message: string;
  action?: PostProcessFeedbackAction;
};

export type PostProcessFeedbackMetadata = {
  postProcessMode?: string | null;
  postProcessFailed?: boolean | null;
  postProcessFallback?: boolean | null;
  postProcessError?: string | null;
};

const LOCAL_FALLBACK_MESSAGE = defineMessage({
  defaultMessage:
    "Online styling failed because {reason}. Your local style was applied instead.",
});
const STYLING_FAILED_MESSAGE = defineMessage({
  defaultMessage:
    "Styling failed because {reason}. The raw transcript is saved in History.",
});
const STYLING_FAILED_HISTORY_DETAILS_MESSAGE = defineMessage({
  defaultMessage: "Styling failed because {reason}.",
});
const STYLING_FAILED_WITHOUT_HISTORY_DICTATION_MESSAGE = defineMessage({
  defaultMessage:
    "Styling failed because {reason}. The app did not insert the transcript or save it in History.",
});
const STYLING_FAILED_WITHOUT_HISTORY_MESSAGE = defineMessage({
  defaultMessage:
    "Styling failed because {reason}. History does not contain the raw transcript.",
});
const UNUSABLE_DICTATION_MESSAGE = defineMessage({
  defaultMessage: "Online styling could not be used for this dictation.",
});
const UNUSABLE_HISTORY_MESSAGE = defineMessage({
  defaultMessage:
    "The provider reply was unusable, so the previous transcript was kept.",
});
const UNUSABLE_HISTORY_WITHOUT_PREVIOUS_TEXT_MESSAGE = defineMessage({
  defaultMessage:
    "The provider reply was unusable, so the raw transcript was saved instead.",
});
const UNUSABLE_HISTORY_WITHOUT_PERSISTENCE_MESSAGE = defineMessage({
  defaultMessage:
    "The provider reply was unusable. The raw transcript is available in this session, but it was not saved in History.",
});
const UNUSABLE_HISTORY_TRUNCATED_MESSAGE = defineMessage({
  defaultMessage:
    "The incomplete styling reply was discarded at the model's output limit. The previous text was kept.",
});
const UNUSABLE_HISTORY_TRUNCATED_WITHOUT_PREVIOUS_TEXT_MESSAGE = defineMessage({
  defaultMessage:
    "The truncated styling reply was discarded at the model's output limit. The raw transcript was saved instead.",
});
const UNUSABLE_HISTORY_UNREADABLE_MESSAGE = defineMessage({
  defaultMessage:
    "The unreadable styling reply was discarded, leaving the previous text in place.",
});
const UNUSABLE_HISTORY_UNREADABLE_WITHOUT_PREVIOUS_TEXT_MESSAGE = defineMessage(
  {
    defaultMessage:
      "The invalid styling reply was discarded, and the raw transcript was saved instead.",
  },
);
const UNUSABLE_IMPORT_MESSAGE = defineMessage({
  defaultMessage:
    "The original transcript was saved because the online styling reply was unusable.",
});
const UNUSABLE_IMPORT_WITHOUT_HISTORY_MESSAGE = defineMessage({
  defaultMessage:
    "The online styling reply was unusable. History does not contain the original transcript.",
});
const FAST_STYLE_TRUNCATION_DICTATION_MESSAGE = defineMessage({
  defaultMessage:
    "Fast styling left the last {droppedChars} characters of that dictation unstyled. The unstyled ending is in History.",
});
const FAST_STYLE_TRUNCATION_AUDIO_MESSAGE = defineMessage({
  defaultMessage:
    "Fast styling left the last {droppedChars} characters of the audio unstyled. The unstyled ending is in History.",
});
const FAST_STYLE_TRUNCATION_WITHOUT_HISTORY_MESSAGE = defineMessage({
  defaultMessage:
    "Fast styling left the last {droppedChars} characters unstyled. The app did not save them in History.",
});

type PostProcessFeedbackOptions = {
  hasPreviousTranscript?: boolean;
  unusableResponseType?: "truncated" | "unreadable";
  canRecoverFromHistory?: boolean;
};

const getUnusableResponseMessage = (
  context: PostProcessFeedbackContext,
  options: PostProcessFeedbackOptions,
) => {
  if (context === "dictation") return UNUSABLE_DICTATION_MESSAGE;
  if (context === "audio-import") {
    return options.canRecoverFromHistory === false
      ? UNUSABLE_IMPORT_WITHOUT_HISTORY_MESSAGE
      : UNUSABLE_IMPORT_MESSAGE;
  }

  const hasPreviousTranscript = options.hasPreviousTranscript ?? true;
  if (!hasPreviousTranscript && options.canRecoverFromHistory === false) {
    return UNUSABLE_HISTORY_WITHOUT_PERSISTENCE_MESSAGE;
  }
  const wasTruncated = options.unusableResponseType === "truncated";
  if (wasTruncated) {
    return hasPreviousTranscript
      ? UNUSABLE_HISTORY_TRUNCATED_MESSAGE
      : UNUSABLE_HISTORY_TRUNCATED_WITHOUT_PREVIOUS_TEXT_MESSAGE;
  }
  if (options.unusableResponseType === "unreadable") {
    return hasPreviousTranscript
      ? UNUSABLE_HISTORY_UNREADABLE_MESSAGE
      : UNUSABLE_HISTORY_UNREADABLE_WITHOUT_PREVIOUS_TEXT_MESSAGE;
  }
  return hasPreviousTranscript
    ? UNUSABLE_HISTORY_MESSAGE
    : UNUSABLE_HISTORY_WITHOUT_PREVIOUS_TEXT_MESSAGE;
};

/**
 * Describe only exceptional post-processing outcomes. Expected local styling
 * and normal online success return null and stay quiet.
 */
export const getPostProcessFeedback = (
  metadata: PostProcessFeedbackMetadata,
  context: PostProcessFeedbackContext,
  options: PostProcessFeedbackOptions = {},
): PostProcessFeedback | null => {
  if (!metadata.postProcessFailed && !metadata.postProcessFallback) {
    return null;
  }

  const intl = getIntl();
  const canRecoverFromHistory = options.canRecoverFromHistory ?? true;

  if (metadata.postProcessFailed) {
    const reason = intl.formatMessage(
      postProcessErrorReason(metadata.postProcessError),
    );
    let message = STYLING_FAILED_WITHOUT_HISTORY_MESSAGE;
    if (context === "history-details") {
      message = STYLING_FAILED_HISTORY_DETAILS_MESSAGE;
    } else if (canRecoverFromHistory) {
      message = STYLING_FAILED_MESSAGE;
    } else if (context === "dictation") {
      message = STYLING_FAILED_WITHOUT_HISTORY_DICTATION_MESSAGE;
    }
    return {
      kind: "failed",
      severity: "error",
      message: intl.formatMessage(message, { reason }),
      action: canRecoverFromHistory ? "history" : undefined,
    };
  }

  if (metadata.postProcessError) {
    const reason = intl.formatMessage(
      postProcessErrorReason(metadata.postProcessError),
    );
    return {
      kind: "local-fallback",
      severity: "info",
      message: intl.formatMessage(LOCAL_FALLBACK_MESSAGE, { reason }),
      action: "fix",
    };
  }

  return {
    kind: "unusable-response",
    severity: "info",
    message: intl.formatMessage(getUnusableResponseMessage(context, options)),
  };
};

type FastStyleTruncationOptions = {
  canRecoverFromHistory: boolean;
  context: "dictation" | "audio";
};

/**
 * Describe a fast-style result that reports an unstyled tail. Source-specific
 * wording stays accurate for dictation and saved audio, while the no-History
 * variant avoids promising a durable recovery path.
 */
export const getFastStyleTruncationMessage = (
  droppedChars: number | null | undefined,
  options: FastStyleTruncationOptions,
): string | null => {
  if (
    typeof droppedChars !== "number" ||
    !Number.isFinite(droppedChars) ||
    droppedChars <= 0
  ) {
    return null;
  }

  let descriptor = FAST_STYLE_TRUNCATION_WITHOUT_HISTORY_MESSAGE;
  if (options.canRecoverFromHistory) {
    descriptor =
      options.context === "dictation"
        ? FAST_STYLE_TRUNCATION_DICTATION_MESSAGE
        : FAST_STYLE_TRUNCATION_AUDIO_MESSAGE;
  }
  return getIntl().formatMessage(descriptor, { droppedChars });
};

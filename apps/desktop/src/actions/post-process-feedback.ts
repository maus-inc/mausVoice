import { defineMessage, type MessageDescriptor } from "react-intl";
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
// The run's raw transcript still sits on the session's History row; only
// the permanent copy is missing, so the wording must not claim History lost it.
const STYLING_FAILED_WITHOUT_HISTORY_MESSAGE = defineMessage({
  defaultMessage:
    "Styling failed because {reason}. The raw transcript is available in this session, but was not saved in History.",
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
// The import keeps a session-only History row with the original transcript,
// so say it is available for now rather than claim History never got it.
const UNUSABLE_IMPORT_WITHOUT_HISTORY_MESSAGE = defineMessage({
  defaultMessage:
    "The online styling reply was unusable. The original transcript is available in this session, but was not saved in History.",
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

const UNUSABLE_IMPORT_BY_PERSISTENCE = {
  recoverable: UNUSABLE_IMPORT_MESSAGE,
  ephemeral: UNUSABLE_IMPORT_WITHOUT_HISTORY_MESSAGE,
} as const;

const getImportUnusableMessage = (
  options: PostProcessFeedbackOptions,
): MessageDescriptor =>
  options.canRecoverFromHistory === false
    ? UNUSABLE_IMPORT_BY_PERSISTENCE.ephemeral
    : UNUSABLE_IMPORT_BY_PERSISTENCE.recoverable;

// For each reply failure type, the wording when the row already holds text
// and the wording when it does not.
const UNUSABLE_HISTORY_MESSAGES_BY_TYPE: Record<
  "truncated" | "unreadable" | "generic",
  readonly [MessageDescriptor, MessageDescriptor]
> = {
  truncated: [
    UNUSABLE_HISTORY_TRUNCATED_MESSAGE,
    UNUSABLE_HISTORY_TRUNCATED_WITHOUT_PREVIOUS_TEXT_MESSAGE,
  ],
  unreadable: [
    UNUSABLE_HISTORY_UNREADABLE_MESSAGE,
    UNUSABLE_HISTORY_UNREADABLE_WITHOUT_PREVIOUS_TEXT_MESSAGE,
  ],
  generic: [
    UNUSABLE_HISTORY_MESSAGE,
    UNUSABLE_HISTORY_WITHOUT_PREVIOUS_TEXT_MESSAGE,
  ],
};

const needsUnrecoverableHistoryWording = (
  options: PostProcessFeedbackOptions,
  hasPreviousTranscript: boolean,
): boolean => !hasPreviousTranscript && options.canRecoverFromHistory === false;

const getHistoryUnusableMessage = (
  options: PostProcessFeedbackOptions,
): MessageDescriptor => {
  const hasPreviousTranscript = options.hasPreviousTranscript ?? true;
  if (needsUnrecoverableHistoryWording(options, hasPreviousTranscript)) {
    return UNUSABLE_HISTORY_WITHOUT_PERSISTENCE_MESSAGE;
  }
  const pair =
    UNUSABLE_HISTORY_MESSAGES_BY_TYPE[
      options.unusableResponseType ?? "generic"
    ];
  return pair[hasPreviousTranscript ? 0 : 1];
};

const getUnusableResponseMessage = (
  context: PostProcessFeedbackContext,
  options: PostProcessFeedbackOptions,
): MessageDescriptor => {
  if (context === "dictation") return UNUSABLE_DICTATION_MESSAGE;
  if (context === "audio-import") return getImportUnusableMessage(options);
  return getHistoryUnusableMessage(options);
};

const getFailedMessageDescriptor = (
  context: PostProcessFeedbackContext,
  canRecoverFromHistory: boolean,
): MessageDescriptor => {
  if (context === "history-details")
    return STYLING_FAILED_HISTORY_DETAILS_MESSAGE;
  if (canRecoverFromHistory) return STYLING_FAILED_MESSAGE;
  if (context === "dictation") {
    return STYLING_FAILED_WITHOUT_HISTORY_DICTATION_MESSAGE;
  }
  return STYLING_FAILED_WITHOUT_HISTORY_MESSAGE;
};

const getFailedFeedback = (
  metadata: PostProcessFeedbackMetadata,
  context: PostProcessFeedbackContext,
  options: PostProcessFeedbackOptions,
): PostProcessFeedback => {
  const intl = getIntl();
  const canRecoverFromHistory = options.canRecoverFromHistory ?? true;
  const reason = intl.formatMessage(
    postProcessErrorReason(metadata.postProcessError),
  );
  const message = getFailedMessageDescriptor(context, canRecoverFromHistory);
  return {
    kind: "failed",
    severity: "error",
    message: intl.formatMessage(message, { reason }),
    action: canRecoverFromHistory ? "history" : undefined,
  };
};

const getLocalFallbackFeedback = (
  metadata: PostProcessFeedbackMetadata,
): PostProcessFeedback => {
  const intl = getIntl();
  const reason = intl.formatMessage(
    postProcessErrorReason(metadata.postProcessError),
  );
  return {
    kind: "local-fallback",
    severity: "info",
    message: intl.formatMessage(LOCAL_FALLBACK_MESSAGE, { reason }),
    action: "fix",
  };
};

const isExceptionalPostProcess = (
  metadata: PostProcessFeedbackMetadata,
): boolean =>
  Boolean(metadata.postProcessFailed) || Boolean(metadata.postProcessFallback);

/**
 * Describe only exceptional post-processing outcomes. Expected local styling
 * and normal online success return null and stay quiet.
 */
export const getPostProcessFeedback = (
  metadata: PostProcessFeedbackMetadata,
  context: PostProcessFeedbackContext,
  options: PostProcessFeedbackOptions = {},
): PostProcessFeedback | null => {
  if (!isExceptionalPostProcess(metadata)) {
    return null;
  }

  if (metadata.postProcessFailed) {
    return getFailedFeedback(metadata, context, options);
  }
  if (metadata.postProcessError) {
    return getLocalFallbackFeedback(metadata);
  }

  return {
    kind: "unusable-response",
    severity: "info",
    message: getIntl().formatMessage(
      getUnusableResponseMessage(context, options),
    ),
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
const hasDroppedTail = (
  droppedChars: number | null | undefined,
): droppedChars is number =>
  typeof droppedChars === "number" &&
  Number.isFinite(droppedChars) &&
  droppedChars > 0;

const getFastStyleTruncationDescriptor = (
  options: FastStyleTruncationOptions,
): MessageDescriptor => {
  if (!options.canRecoverFromHistory) {
    return FAST_STYLE_TRUNCATION_WITHOUT_HISTORY_MESSAGE;
  }
  return options.context === "dictation"
    ? FAST_STYLE_TRUNCATION_DICTATION_MESSAGE
    : FAST_STYLE_TRUNCATION_AUDIO_MESSAGE;
};

export const getFastStyleTruncationMessage = (
  droppedChars: number | null | undefined,
  options: FastStyleTruncationOptions,
): string | null => {
  if (!hasDroppedTail(droppedChars)) return null;
  return getIntl().formatMessage(getFastStyleTruncationDescriptor(options), {
    droppedChars,
  });
};

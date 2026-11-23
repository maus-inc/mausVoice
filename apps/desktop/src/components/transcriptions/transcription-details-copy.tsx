import type { ReactNode } from "react";
import {
  FormattedMessage,
  type IntlShape,
  type MessageDescriptor,
} from "react-intl";
import { getPostProcessFeedback } from "../../actions/post-process-feedback";
import {
  isPostProcessErrorCategory,
  postProcessErrorReason,
} from "../../actions/post-process-error-category";
import {
  getUnusableResponseType,
  isUnusableResponseWarning,
} from "../../actions/transcriptions.actions";

type WarningRow = {
  transcript: string;
  sanitizedTranscript?: string | null;
  warnings?: string[] | null;
  postProcessFailed?: boolean | null;
  postProcessFallback?: boolean | null;
};

export const resolveCategoryWarning = (
  warning: string,
  postProcessFailed: boolean | null | undefined,
  postProcessFallback: boolean | null | undefined,
  formatReason: (descriptor: MessageDescriptor) => string,
): string => {
  const feedback = getPostProcessFeedback(
    {
      postProcessFailed,
      postProcessFallback,
      postProcessError: warning,
    },
    "history-details",
  );
  return feedback?.message ?? formatReason(postProcessErrorReason(warning));
};

// A run that saved the raw ASR leaves the row's displayed text equal to its
// sanitized transcript column; a run that kept the previous text leaves the
// two different. Rows recorded without the column cannot say which happened,
// and the feedback module's default wording applies to them.
const getUnusableRowHadPreviousText = (row: {
  transcript: string;
  sanitizedTranscript?: string | null;
}): boolean | undefined => {
  const sanitized = row.sanitizedTranscript;
  if (sanitized === null || sanitized === undefined) {
    return undefined;
  }
  return row.transcript !== sanitized;
};

// Rows that fell back after an unusable reply keep the raw marker as their
// warning, which means nothing to the user. Show the same explanation the
// retranscribe toast used instead.
const resolveUnusableWarning = (
  warning: string,
  hasPreviousTranscript: boolean | undefined,
): string => {
  const feedback = getPostProcessFeedback(
    {
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: null,
    },
    "history-details",
    {
      unusableResponseType: getUnusableResponseType(warning),
      hasPreviousTranscript,
    },
  );
  return feedback?.message ?? warning;
};

export const formatTranscriptionModeLabel = (
  mode?: string | null,
): ReactNode => {
  if (mode === "api") {
    return <FormattedMessage defaultMessage="API" />;
  }
  if (mode === "local") {
    return <FormattedMessage defaultMessage="Local" />;
  }
  return <FormattedMessage defaultMessage="Unknown" />;
};

export const formatPostProcessModeLabel = (mode?: string | null): ReactNode => {
  if (mode === "api") {
    return <FormattedMessage defaultMessage="API" />;
  }
  if (mode === "fast") {
    return <FormattedMessage defaultMessage="Fast (local)" />;
  }
  return <FormattedMessage defaultMessage="Disabled" />;
};

/**
 * The row is read through one local so the guarded accesses below stay bare:
 * an optional chain next to a bare property read on the same value reads as an
 * unresolved nullability question, and after this guard there is none left.
 */
export const buildTranscriptionWarnings = (
  row: WarningRow | null | undefined,
  intl: IntlShape,
): string[] => {
  const rowWarnings = row?.warnings;
  if (!row || !rowWarnings) {
    return [];
  }

  return rowWarnings
    .map((warning) => warning.trim())
    .filter((warning) => warning.length > 0)
    .map((warning) => {
      if (isPostProcessErrorCategory(warning)) {
        return resolveCategoryWarning(
          warning,
          row.postProcessFailed,
          row.postProcessFallback,
          (descriptor) => intl.formatMessage(descriptor),
        );
      }
      // Translate only the known unusable-reply markers; a fallback row can
      // also carry unrelated warnings that must stay verbatim.
      if (
        !row.postProcessFailed &&
        row.postProcessFallback &&
        isUnusableResponseWarning(warning)
      ) {
        return resolveUnusableWarning(
          warning,
          getUnusableRowHadPreviousText(row),
        );
      }
      return warning;
    });
};

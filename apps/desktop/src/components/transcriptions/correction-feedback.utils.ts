import type { IntlShape } from "react-intl";
import type { SaveCorrectedTranscriptResult } from "../../actions/auto-learn.actions";

/** Keep dictionary feedback distinct from a correction suppressed by Incognito. */
export const correctionFeedback = (
  {
    learnedTerms,
    failedTerms,
    dictionarySuppressed,
  }: SaveCorrectedTranscriptResult,
  intl: IntlShape,
): { message: string; mode: "success" | "error" } => {
  if (learnedTerms.length === 1 && failedTerms === 0) {
    return {
      message: intl.formatMessage(
        { defaultMessage: 'Added "{term}" to your dictionary' },
        { term: learnedTerms[0] },
      ),
      mode: "success",
    };
  }
  if (learnedTerms.length > 0 && failedTerms === 0) {
    return {
      message: intl.formatMessage(
        { defaultMessage: "Added {count} words to your dictionary" },
        { count: learnedTerms.length },
      ),
      mode: "success",
    };
  }
  if (learnedTerms.length > 0 && failedTerms > 0) {
    return {
      message: intl.formatMessage(
        {
          defaultMessage:
            "Added {added} words to your dictionary ({failed} failed)",
        },
        { added: learnedTerms.length, failed: failedTerms },
      ),
      mode: "success",
    };
  }
  if (failedTerms > 0) {
    return {
      message: intl.formatMessage({
        defaultMessage:
          "Transcript updated, but the corrected words could not be added to your dictionary.",
      }),
      mode: "error",
    };
  }
  if (dictionarySuppressed) {
    return {
      message: intl.formatMessage({
        defaultMessage:
          "Transcript updated. Nothing was added to your dictionary because Incognito is on.",
      }),
      mode: "success",
    };
  }
  return {
    message: intl.formatMessage({ defaultMessage: "Transcript updated" }),
    mode: "success",
  };
};

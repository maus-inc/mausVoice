import { getIntl } from "../i18n/intl";
import { runToast, showToast } from "../actions/toast.actions";

export const showDictationReviewExpiredToast = (): void => {
  runToast(
    showToast({
      message: getIntl().formatMessage({
        defaultMessage:
          "Review expired — the transcript is kept in your history.",
      }),
      toastType: "info",
      duration: 8000,
      action: "open_transcriptions",
    }),
  );
};

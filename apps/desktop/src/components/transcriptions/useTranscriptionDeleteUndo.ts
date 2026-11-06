import type { Transcription } from "@maus-inc/types";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  scheduleTranscriptionDelete,
  undoTranscriptionDelete,
} from "../../utils/pending-transcription-delete";

/** Schedule deletion and offer a bounded undo action with localized feedback. */
export const useTranscriptionDeleteUndo = (
  transcription: Transcription | undefined,
) => {
  const intl = useIntl();
  const handleDeleteTranscript = useCallback(
    (targetId: string) => {
      const snapshot = transcription;
      if (!snapshot) {
        return;
      }
      const undoWindowMs = 5000;
      try {
        scheduleTranscriptionDelete(snapshot, undoWindowMs);
      } catch {
        showErrorSnackbar(
          intl.formatMessage({
            defaultMessage: "Failed to schedule delete.",
          }),
        );
        return;
      }
      showSnackbar(
        intl.formatMessage({ defaultMessage: "Delete successful" }),
        {
          mode: "success",
          duration: undoWindowMs,
          action: {
            label: intl.formatMessage({ defaultMessage: "Undo" }),
            onClick: () => {
              if (!undoTranscriptionDelete(targetId)) {
                showErrorSnackbar(
                  intl.formatMessage({
                    defaultMessage: "Unable to undo delete.",
                  }),
                );
              }
            },
          },
        },
      );
    },
    [intl, transcription],
  );

  return handleDeleteTranscript;
};

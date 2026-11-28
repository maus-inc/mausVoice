import { useEffect, useRef, useState, type RefObject } from "react";
import type { IntlShape } from "react-intl";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { saveCorrectedTranscript } from "../../actions/auto-learn.actions";

type DictionaryOutcome = {
  learnedTerms: string[];
  failedTerms: number;
  dictionarySuppressed: boolean;
};

const describeDictionaryOutcome = (
  intl: IntlShape,
  { learnedTerms, failedTerms, dictionarySuppressed }: DictionaryOutcome,
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
  if (learnedTerms.length > 0) {
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
    // Auto-learn was on and the glossary write was refused, so an empty
    // `learnedTerms` here is a policy decision rather than a correction that
    // taught nothing. Saying "Transcript updated" and stopping there leaves
    // the user reading a promise the mode does not keep.
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

export type FinalTranscriptEditor = {
  isEditingFinal: boolean;
  finalDraft: string;
  setFinalDraft: (value: string) => void;
  isSavingFinal: boolean;
  finalDraftRef: RefObject<HTMLTextAreaElement | null>;
  startEditingFinal: () => void;
  cancelEditingFinal: () => void;
  handleSaveFinal: () => Promise<void>;
};

/**
 * Inline editing of the final transcript. The field is focused after commit
 * rather than with a DOM `autoFocus` prop: `autoFocus` fires as an attribute
 * and cannot be deferred, so it races anything that moves focus in the same
 * commit. This mirrors ContextMenu's own rule. The field renders only while
 * editing, so the effect is keyed on `isEditingFinal` rather than `[]`: this
 * dialog stays mounted for the whole app lifetime, so a mount-only effect
 * would never fire.
 */
export const useFinalTranscriptEditor = ({
  transcriptionId,
  open,
  finalTranscriptText,
  intl,
}: {
  transcriptionId: string | undefined;
  open: boolean;
  finalTranscriptText: string;
  intl: IntlShape;
}): FinalTranscriptEditor => {
  const [isEditingFinal, setIsEditingFinal] = useState(false);
  const [finalDraft, setFinalDraft] = useState("");
  const [isSavingFinal, setIsSavingFinal] = useState(false);
  const finalDraftRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isEditingFinal) finalDraftRef.current?.focus();
  }, [isEditingFinal]);

  useEffect(() => {
    setIsEditingFinal(false);
    setFinalDraft("");
  }, [open, transcriptionId]);

  const startEditingFinal = () => {
    setFinalDraft(finalTranscriptText);
    setIsEditingFinal(true);
  };

  const cancelEditingFinal = () => {
    setIsEditingFinal(false);
    setFinalDraft("");
  };

  const handleSaveFinal = async () => {
    if (!transcriptionId) {
      return;
    }

    // Saving unchanged text would perform a needless DB write and run the
    // full glossary extraction pipeline for nothing.
    if (finalDraft.trim() === finalTranscriptText.trim()) {
      cancelEditingFinal();
      return;
    }

    setIsSavingFinal(true);
    try {
      const outcome = await saveCorrectedTranscript({
        transcriptionId,
        correctedText: finalDraft,
      });
      cancelEditingFinal();
      const { message, mode } = describeDictionaryOutcome(intl, outcome);
      showSnackbar(message, { mode });
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setIsSavingFinal(false);
    }
  };

  return {
    isEditingFinal,
    finalDraft,
    setFinalDraft,
    isSavingFinal,
    finalDraftRef,
    startEditingFinal,
    cancelEditingFinal,
    handleSaveFinal,
  };
};

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  CorrectionRetiredError,
  saveCorrectedTranscript,
} from "../../actions/auto-learn.actions";
import { captureUserSession } from "../../utils/user-session.utils";
import { useAppStore } from "../../store";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { correctionFeedback } from "./correction-feedback.utils";

/** Editing and persisting the final transcript is independent of the metadata view. */
/** A save whose dialog or account was replaced cannot report anything. */
const saveIsStale = (
  generation: number,
  currentGeneration: number,
  isCurrentSession: () => boolean,
): boolean => generation !== currentGeneration || !isCurrentSession();

/** A retired correction already reported itself; anything else surfaces here. */
const reportSaveFailure = (error: unknown): void => {
  if (error instanceof CorrectionRetiredError) return;
  showErrorSnackbar(error);
};

export const useFinalTranscriptEditor = (
  open: boolean,
  transcriptionId: string | null | undefined,
  finalText: string,
) => {
  const intl = useIntl();
  const authUid = useAppStore((state) => state.auth?.uid ?? null);
  const authSessionNonce = useAppStore((state) => state.authSessionNonce);
  const [isEditingFinal, setIsEditingFinal] = useState(false);
  const [finalDraft, setFinalDraft] = useState("");
  const [isSavingFinal, setIsSavingFinal] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(false);
  const contextGeneration = useRef(0);
  const finalDraftRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus after the field mounts; autoFocus can race another focus in the same commit.
  useEffect(() => {
    if (isEditingFinal) finalDraftRef.current?.focus();
  }, [isEditingFinal]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    contextGeneration.current += 1;
    setIsEditingFinal(false);
    setFinalDraft("");
    return () => {
      contextGeneration.current += 1;
    };
  }, [open, transcriptionId, authUid, authSessionNonce]);

  const startEditingFinal = () => {
    setFinalDraft(finalText);
    setIsEditingFinal(true);
  };
  const cancelEditingFinal = () => {
    setIsEditingFinal(false);
    setFinalDraft("");
  };
  const handleSaveFinal = async () => {
    if (!transcriptionId || savingRef.current) return;
    // An unchanged edit needs neither a database write nor glossary extraction.
    if (finalDraft.trim() === finalText.trim()) {
      cancelEditingFinal();
      return;
    }
    // Acquire synchronously: two clicks can arrive before React renders disabled.
    savingRef.current = true;
    const generation = contextGeneration.current;
    const isCurrentSession = captureUserSession();
    // A save started for an earlier dialog or account cannot change the new
    // draft or report its result to the successor.
    const isStale = () =>
      saveIsStale(generation, contextGeneration.current, isCurrentSession);
    setIsSavingFinal(true);
    try {
      const result = await saveCorrectedTranscript({
        transcriptionId,
        correctedText: finalDraft,
      });
      if (isStale()) return;
      cancelEditingFinal();
      const feedback = correctionFeedback(result, intl);
      showSnackbar(feedback.message, { mode: feedback.mode });
    } catch (error) {
      if (!isStale()) reportSaveFailure(error);
    } finally {
      savingRef.current = false;
      if (mounted.current) setIsSavingFinal(false);
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { Tone } from "@maus-inc/types";
import { deleteTone, upsertTone } from "../../actions/tone.actions";
import { getAppState } from "../../store";
import { sameToneDraft } from "./tone-form.utils";
import type { ToneEditDraft } from "./use-tone-edit-draft";

const trimOrUndefined = (value: string): string | undefined =>
  value.trim() || undefined;

type ToneEditWriteInput = {
  tone: Tone;
  onClose: () => void;
  draft: ToneEditDraft;
  baseline: Tone;
  trimmedName: string;
  trimmedPrompt: string;
  isValid: boolean;
  hasChanges: boolean;
};

export const useToneEditWrite = ({
  tone,
  onClose,
  draft,
  baseline,
  trimmedName,
  trimmedPrompt,
  isValid,
  hasChanges,
}: ToneEditWriteInput) => {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDiscardOpen, setIsDiscardOpen] = useState(false);
  // One shared busy latch: Save and Delete must never interleave, or the
  // slower command can resurrect a deleted style or overwrite a deletion.
  const isBusy = isSaving || isDeleting;
  // State drives the buttons; the ref takes ownership before React commits
  // that state, so two handlers in the same event batch cannot both write.
  const writePending = useRef(false);

  const handleSave = useCallback(async () => {
    if (!isValid || isBusy || writePending.current) {
      return;
    }
    // Read synchronously as well: an external store update and this click
    // can share a React batch before the new props/disabled state commit.
    const liveTone = getAppState().toneById[tone.id];
    if (!liveTone || !sameToneDraft(liveTone, baseline)) return;
    writePending.current = true;
    setIsSaving(true);
    try {
      await upsertTone({
        ...liveTone,
        name: trimmedName,
        promptTemplate: trimmedPrompt,
        category: trimOrUndefined(draft.category),
        outputLength: trimOrUndefined(draft.outputLength),
        exampleInputOutput: trimOrUndefined(draft.exampleInputOutput),
      });
      if (mounted.current) onClose();
    } catch {
      // upsertTone already surfaced an error snackbar; swallow the rethrow
      // so the UI callback does not create an unhandled rejection.
    } finally {
      writePending.current = false;
      setIsSaving(false);
    }
  }, [
    isValid,
    isBusy,
    baseline,
    tone,
    trimmedName,
    trimmedPrompt,
    draft,
    onClose,
  ]);

  const handleDeleteTone = useCallback(async () => {
    if (isBusy || writePending.current) {
      return;
    }
    writePending.current = true;
    setIsDeleting(true);
    try {
      await deleteTone(tone.id);
      if (mounted.current) {
        setIsConfirmOpen(false);
        onClose();
      }
    } catch {
      // deleteTone already surfaced an error snackbar; swallow the rethrow
      // so the confirm-dialog callback does not create an unhandled rejection.
    } finally {
      writePending.current = false;
      setIsDeleting(false);
    }
  }, [tone.id, onClose, isBusy]);

  const handleRequestClose = useCallback(() => {
    if (isBusy || writePending.current) {
      return;
    }
    if (hasChanges) {
      setIsDiscardOpen(true);
      return;
    }
    onClose();
  }, [hasChanges, onClose, isBusy]);

  const handleDiscard = useCallback(() => {
    if (isBusy || writePending.current) return;
    setIsDiscardOpen(false);
    onClose();
  }, [isBusy, onClose]);

  const handleCancelDiscard = useCallback(() => {
    if (!writePending.current) setIsDiscardOpen(false);
  }, []);

  return {
    isBusy,
    isConfirmOpen,
    setIsConfirmOpen,
    isDiscardOpen,
    handleSave,
    handleDeleteTone,
    handleRequestClose,
    handleDiscard,
    handleCancelDiscard,
  };
};

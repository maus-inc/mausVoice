import { Tone } from "@maus-inc/types";
import { useMemo } from "react";
import { closeToneEditorDialog } from "../../actions/tone.actions";
import { useAppStore } from "../../store";
import { ToneCreateWizard } from "./ToneCreateWizard";
import { ToneEditDialog } from "./ToneEditForm";

export const ToneEditorDialog = () => {
  const toneEditor = useAppStore((state) => state.toneEditor);
  const toneById = useAppStore((state) => state.toneById);

  const editingTone: Tone | null = useMemo(
    () =>
      toneEditor.mode === "edit" && toneEditor.toneId
        ? (toneById[toneEditor.toneId] ?? null)
        : null,
    [toneEditor.mode, toneEditor.toneId, toneById],
  );

  if (!toneEditor.open) {
    return null;
  }

  const key = `${toneEditor.mode}:${toneEditor.toneId ?? "new"}`;

  if (toneEditor.mode === "edit" && editingTone) {
    return (
      <ToneEditDialog
        key={key}
        tone={editingTone}
        onClose={closeToneEditorDialog}
      />
    );
  }

  // Create mode, or edit mode whose tone vanished: the wizard is the safer
  // surface than an empty editor.
  return <ToneCreateWizard key={key} onClose={closeToneEditorDialog} />;
};

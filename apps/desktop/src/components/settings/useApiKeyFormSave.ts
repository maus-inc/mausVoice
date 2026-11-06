import { useCallback, useRef, useState } from "react";

/** Keep add and edit forms guarded and locked while their save is pending. */
export const useApiKeyFormSave = (
  canSave: boolean,
  save: () => Promise<void>,
) => {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (!canSave || savingRef.current) return;
    // State updates render asynchronously; acquire the lock before calling save
    // so two clicks in the same render cannot create duplicate requests.
    savingRef.current = true;
    setSaving(true);
    try {
      await save();
    } catch (error) {
      console.error("Failed to save API key", error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [canSave, save]);
  return { saving, handleSave };
};

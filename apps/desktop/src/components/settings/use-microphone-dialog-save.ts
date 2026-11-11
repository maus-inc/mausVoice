import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useIntl } from "react-intl";
import { toast } from "sonner";

import { setPreferredMicrophone } from "../../actions/user.actions";
import { produceAppState } from "../../store";
import type { Nullable } from "@maus-inc/types";

import { revealFeedback } from "./reveal-feedback";

/**
 * The dialog's save, close and dirty state, in one place.
 *
 * This was five `useState` hooks, a ref and four handlers inside the component,
 * which is what pushed its cyclomatic complexity to 19. The state is genuinely a
 * unit: `hasChanges` decides whether Save is enabled and whether saving does
 * anything, `saving` locks both buttons, and `saveInFlight` exists because state
 * updates are not immediate -- a second click can arrive before `saving` is
 * true, and the guard has to see it. Splitting those across two components
 * would mean passing four values and three callbacks down, so they stay
 * together and the component keeps only the render.
 *
 * The open transition resets the draft. That is deliberately an effect rather
 * than a `key` on the dialog: the dialog is mounted once and toggles `open`, so a
 * `key` would remount the selector and the tester every time it reopened.
 */
export const useMicrophoneDialogSave = ({
  open,
  savedPreference,
}: {
  readonly open: boolean;
  readonly savedPreference: Nullable<string>;
}) => {
  const intl = useIntl();
  const [selected, setSelected] = useState<Nullable<string>>(savedPreference);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // A ref, not the `saving` state: `setSaving(true)` is not visible to a second
  // click dispatched before React re-renders, and that second click would start
  // a second write.
  const saveInFlight = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // Only the error can move the view. The success case is a toast, and a toast
  // is outside the dialog's scroll container, so there is nothing for it to
  // scroll to, and no live region to fill because sonner announces it.
  useLayoutEffect(() => {
    if (!saveError) return;
    revealFeedback(contentRef.current, feedbackRef.current);
  }, [saveError]);

  // Reset the draft when the dialog opens. `savedPreference` is in the
  // dependencies because a preference changed in another window while this one
  // was closed still has to be what the dialog shows.
  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected(savedPreference);
    setHasChanges(false);
    setSaveError(false);
  }, [open, savedPreference]);

  const selectDevice = useCallback(
    (next: Nullable<string>) => {
      setSelected(next ?? null);
      setHasChanges((next ?? null) !== (savedPreference ?? null));
      setSaveError(false);
    },
    [savedPreference],
  );

  const save = useCallback(async () => {
    if (!hasChanges || saving || saveInFlight.current) {
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    setSaveError(false);

    try {
      await setPreferredMicrophone(selected ?? null);
      setHasChanges(false);
      // Deliberately not paired with any in-dialog confirmation: sonner's toast
      // is the announcement, and rendering the same sentence in a second live
      // region makes a screen reader say it twice.
      toast.success(
        intl.formatMessage({ defaultMessage: "Preference saved." }),
        { duration: 5000 },
      );
    } catch {
      setSaveError(true);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [hasChanges, intl, saving, selected]);

  const requestClose = useCallback(() => {
    // Not closable mid-save: the write is already on its way, and dismissing the
    // dialog would leave the user with no feedback for it.
    if (saveInFlight.current) return;
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = false;
    });
  }, []);

  return {
    selected,
    selectDevice,
    hasChanges,
    saving,
    saveError,
    save,
    requestClose,
    contentRef,
    feedbackRef,
  };
};

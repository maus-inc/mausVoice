import { useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import type { SnackbarAction } from "../../state/app.state";

type TimedSnackbarActionProps = {
  action: SnackbarAction;
  toastId: string;
  onMount: (element: HTMLButtonElement | null) => void;
};

/** Keeps a timed Undo's visible lifetime aligned with its underlying deadline. */
export const TimedSnackbarAction = ({
  action,
  toastId,
  onMount,
}: TimedSnackbarActionProps) => {
  const ref = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    const button = ref.current;
    if (!button) return;
    onMount(button);
    const title = button
      .closest("[data-sonner-toast]")
      ?.querySelector<HTMLElement>("[data-title]");
    if (title) title.id = descriptionId;
    if (action.focusOnShow && document.activeElement === document.body)
      button.focus();
    const timer = window.setTimeout(
      () => {
        const toastElement = button.closest("[data-sonner-toast]");
        if (toastElement?.contains(document.activeElement))
          action.onFocusReturn?.(false);
        toast.dismiss(toastId);
      },
      Math.max(0, (action.expiresAt ?? Date.now()) - Date.now()),
    );
    return () => {
      clearTimeout(timer);
      onMount(null);
    };
  }, [action, descriptionId, onMount, toastId]);
  return (
    <button
      ref={ref}
      type="button"
      data-button
      data-action
      aria-describedby={descriptionId}
      onClick={() => {
        const hadFocus = document.activeElement === ref.current;
        action.onClick();
        if (hadFocus) action.onFocusReturn?.(true);
        toast.dismiss(toastId);
      }}
    >
      {action.label}
    </button>
  );
};

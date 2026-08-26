import { invoke } from "@tauri-apps/api/core";
import { getIntl } from "../i18n/intl";
import { ToastAction, ToastType } from "../types/toast.types";

function getActionLabel(action: ToastAction): string {
  const intl = getIntl();
  switch (action) {
    case "upgrade":
      return intl.formatMessage({ defaultMessage: "Upgrade" });
    case "open_agent_settings":
      return intl.formatMessage({ defaultMessage: "Fix" });
    case "surface_window":
      return intl.formatMessage({ defaultMessage: "Open" });
    case "confirm_cancel_transcription":
      return intl.formatMessage({ defaultMessage: "Yes, cancel" });
    case "auto_learn_accept":
      return intl.formatMessage({ defaultMessage: "Add" });
    case "auto_learn_reject":
      return intl.formatMessage({ defaultMessage: "Ignore" });
  }
}

export type ShowToastOptions = {
  message: string;
  toastType?: ToastType;
  duration?: number;
  action?: ToastAction;
  /** Optional second (reject) action, rendered beside the primary action. */
  rejectAction?: ToastAction;
};

export async function showToast(options: ShowToastOptions): Promise<void> {
  const durationSec = options.duration ? options.duration / 1000 : undefined;
  await invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({
      type: "toast",
      message: options.message,
      toast_type: options.toastType ?? "info",
      duration: durationSec,
      action: options.action ?? null,
      action_label: options.action ? getActionLabel(options.action) : null,
      reject_action: options.rejectAction ?? null,
      reject_action_label: options.rejectAction
        ? getActionLabel(options.rejectAction)
        : null,
    }),
  });
}

export async function dismissToast(): Promise<void> {
  await invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "dismiss_toast" }),
  });
}

/**
 * In-flight toast. The native pill treats a missing duration as 2.5s
 * (`FLASH_DURATION`), so callers that want the toast to outlive a long job
 * must pass an explicit duration.
 */
export async function showPersistentToast(
  message: string,
  duration: number,
): Promise<void> {
  await showToast({ message, toastType: "info", duration });
}

export async function showCompletionToast(
  message: string,
  duration = 4000,
): Promise<void> {
  await showToast({ message, toastType: "info", duration });
}

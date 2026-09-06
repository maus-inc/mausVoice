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
    case "open_transcriptions":
      return intl.formatMessage({ defaultMessage: "Open history" });
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

/**
 * Serializes native toast IPC. Each call to `sync_native_pill_assistant` is a
 * separate round trip, so concurrent show/dismiss calls can arrive at the pill
 * out of order and leave a dismissed toast on screen for its full duration.
 * Chaining keeps the pill's view of the sequence identical to call order.
 */
let toastQueue: Promise<void> = Promise.resolve();

const enqueueToastCommand = (
  payload: Record<string, unknown>,
): Promise<void> => {
  const next = toastQueue.then(() =>
    invoke<void>("sync_native_pill_assistant", {
      payload: JSON.stringify(payload),
    }),
  );
  // Keep the chain alive after a rejection so one failed toast cannot wedge
  // every later one, while still surfacing the error to this caller.
  toastQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

export async function showToast(options: ShowToastOptions): Promise<void> {
  const durationSec = options.duration ? options.duration / 1000 : undefined;
  await enqueueToastCommand({
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
  });
}

export async function dismissToast(): Promise<void> {
  await enqueueToastCommand({ type: "dismiss_toast" });
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

import { invoke } from "@tauri-apps/api/core";
import { defineMessage, type MessageDescriptor } from "react-intl";
import { getIntl } from "../i18n/intl";
import {
  encodeToastActionToken,
  type ToastAction,
  type ToastType,
} from "../types/toast.types";

const UPGRADE_TOAST_ACTION_LABEL = defineMessage({ defaultMessage: "Upgrade" });
const FIX_TOAST_ACTION_LABEL = defineMessage({ defaultMessage: "Fix" });
const OPEN_TOAST_ACTION_LABEL = defineMessage({ defaultMessage: "Open" });
const OPEN_HISTORY_TOAST_ACTION_LABEL = defineMessage({
  defaultMessage: "Open history",
});
const CONFIRM_CANCEL_TOAST_ACTION_LABEL = defineMessage({
  defaultMessage: "Yes, cancel",
});
const ADD_TOAST_ACTION_LABEL = defineMessage({ defaultMessage: "Add" });
const IGNORE_TOAST_ACTION_LABEL = defineMessage({ defaultMessage: "Ignore" });

/** Every action's button wording, keyed so no path can fall off the end. */
const TOAST_ACTION_LABELS: Record<ToastAction, MessageDescriptor> = {
  upgrade: UPGRADE_TOAST_ACTION_LABEL,
  open_agent_settings: FIX_TOAST_ACTION_LABEL,
  open_post_processing_settings: FIX_TOAST_ACTION_LABEL,
  surface_window: OPEN_TOAST_ACTION_LABEL,
  open_transcriptions: OPEN_HISTORY_TOAST_ACTION_LABEL,
  confirm_cancel_transcription: CONFIRM_CANCEL_TOAST_ACTION_LABEL,
  auto_learn_accept: ADD_TOAST_ACTION_LABEL,
  auto_learn_reject: IGNORE_TOAST_ACTION_LABEL,
};

export const getToastActionLabel = (action: ToastAction): string =>
  getIntl().formatMessage(TOAST_ACTION_LABELS[action]);

export type ShowToastOptions = {
  message: string;
  toastType?: ToastType;
  duration?: number;
  action?: ToastAction;
  /** Optional second (reject) action, rendered beside the primary action. */
  rejectAction?: ToastAction;
  /**
   * The proposal this prompt belongs to, echoed back on a click so the handler
   * can tell a prompt the user is still looking at from one the app has already
   * moved past. Both actions carry it: Add and Ignore answer the same prompt.
   */
  proposalId?: string;
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
    action: options.action
      ? encodeToastActionToken(options.action, options.proposalId)
      : null,
    action_label: options.action ? getToastActionLabel(options.action) : null,
    reject_action: options.rejectAction
      ? encodeToastActionToken(options.rejectAction, options.proposalId)
      : null,
    reject_action_label: options.rejectAction
      ? getToastActionLabel(options.rejectAction)
      : null,
  });
}

export async function dismissToast(): Promise<void> {
  await enqueueToastCommand({ type: "dismiss_toast" });
}

/**
 * Fire a toast without awaiting it. Native toast IPC can reject, and a bare
 * `void showToast(...)` would surface that as an unhandled rejection, so the
 * failure is logged and swallowed here instead.
 */
export const runToast = (work: Promise<void>): void => {
  void work.catch((error: unknown) => {
    console.error("Toast command failed", error);
  });
};

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

export const showCompletionToast = async (
  message: string,
  duration = 4000,
  action?: ToastAction,
): Promise<void> => {
  await showToast({ message, toastType: "info", duration, action });
};

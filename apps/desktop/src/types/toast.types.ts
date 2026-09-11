export type ToastType = "info" | "error";

export type ToastAction =
  | "upgrade"
  | "open_agent_settings"
  | "surface_window"
  | "open_transcriptions"
  | "confirm_cancel_transcription"
  | "auto_learn_accept"
  | "auto_learn_reject";

export type ToastActionPayload = {
  action: ToastAction;
};

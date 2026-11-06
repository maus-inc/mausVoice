import { invoke } from "@tauri-apps/api/core";

export const sendPillFlashMessage = (message: string): void => {
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({
      type: "toast",
      message,
      toast_type: "info",
      duration: null,
      action: null,
      action_label: null,
      reject_action: null,
      reject_action_label: null,
    }),
  }).catch(console.error);
};

export const sendPillFireworks = (message: string): void => {
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "fireworks", message }),
  }).catch(console.error);
};

export const sendPillFlame = (message: string): void => {
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "flame", message }),
  }).catch(console.error);
};

export const sendPillStageText = (text: string | null): void => {
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "stage_text", text }),
  }).catch(console.error);
};

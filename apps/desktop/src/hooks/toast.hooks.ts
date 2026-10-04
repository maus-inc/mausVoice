import {
  decodeToastActionToken,
  ToastActionPayload,
} from "../types/toast.types";
import { useTauriListen } from "./tauri.hooks";

export const useToastAction = (
  callback: (payload: ToastActionPayload) => void | Promise<void>,
) => {
  // The pill echoes back the action token it was handed, and that token carries
  // the proposal id for a prompt that has one. Decoding once here keeps the wire
  // form out of every consumer, so they all see a `ToastAction` plus an optional
  // `proposalId` rather than a string each has to parse.
  useTauriListen<{ action?: unknown }>("toast-action", (raw) =>
    callback(
      decodeToastActionToken(typeof raw?.action === "string" ? raw.action : ""),
    ),
  );
};

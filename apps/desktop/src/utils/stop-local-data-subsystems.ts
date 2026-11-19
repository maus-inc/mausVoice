import { invoke } from "@tauri-apps/api/core";
import { stopNativeRecording } from "./native-recording-session";

/** Stop the listener before the recorder, while attempting both on failure. */
export const stopLocalDataSubsystems = async (): Promise<void> => {
  let listenerFailure: unknown;
  let listenerFailed = false;
  try {
    await invoke("stop_key_listener");
  } catch (error) {
    listenerFailed = true;
    listenerFailure = error;
  }

  try {
    await stopNativeRecording();
  } catch (error) {
    if (!listenerFailed) throw error;
  }
  if (listenerFailed) throw listenerFailure;
};

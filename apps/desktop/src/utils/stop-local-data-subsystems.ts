import { invoke } from "@tauri-apps/api/core";

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
    await invoke("stop_recording");
  } catch (error) {
    if (!listenerFailed) throw error;
  }
  if (listenerFailed) throw listenerFailure;
};

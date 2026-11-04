import { invoke } from "@tauri-apps/api/core";
import { withLocalDataWrite } from "../../utils/local-data-write-gate";

/** Keep an in-flight microphone start ahead of destructive local cleanup. */
export const invokeGuardedRecordingStart = <T>(
  preferredMicrophone: string | null,
): Promise<T> =>
  withLocalDataWrite(() =>
    invoke<T>("start_recording", { args: { preferredMicrophone } }),
  );

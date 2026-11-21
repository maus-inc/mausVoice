import { commands, NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { invoke } from "@tauri-apps/api/core";
import { BaseRepo } from "./base.repo";

export abstract class BaseNativeRepo extends BaseRepo {
  abstract requestAdminRelaunch(): Promise<NativeSetupResult>;
  abstract quitApp(): Promise<void>;
  /** Replays the pill's locate outline. */
  abstract locatePill(): Promise<void>;
}

export class LocalNativeRepo extends BaseNativeRepo {
  async requestAdminRelaunch(): Promise<NativeSetupResult> {
    return commands.requestAdminRelaunch();
  }

  async quitApp(): Promise<void> {
    await commands.quitApp();
  }

  async locatePill(): Promise<void> {
    await invoke("sync_native_pill_assistant", {
      payload: JSON.stringify({ type: "locate" }),
    });
  }
}

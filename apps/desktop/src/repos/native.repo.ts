import {
  CaptureStartupStage,
  commands,
  NativeSetupResult,
} from "@maus-inc/desktop-native-apis";
import { invoke } from "@tauri-apps/api/core";
import { BaseRepo } from "./base.repo";

export abstract class BaseNativeRepo extends BaseRepo {
  abstract requestAdminRelaunch(): Promise<NativeSetupResult>;
  abstract prepareMicrophone(preferred: string | null): Promise<string>;
  abstract quitApp(): Promise<void>;
  /** Replays the pill's locate outline. */
  abstract locatePill(): Promise<void>;
  /** One line describing the capture path, for a diagnostics export. */
  abstract microphoneReadinessReport(): Promise<string>;
  /** The stage timing of the most recent capture start, oldest first. */
  abstract captureStartupTiming(): Promise<CaptureStartupStage[]>;
}

export class LocalNativeRepo extends BaseNativeRepo {
  async requestAdminRelaunch(): Promise<NativeSetupResult> {
    return commands.requestAdminRelaunch();
  }

  async prepareMicrophone(preferred: string | null): Promise<string> {
    const result = await commands.prepareMicrophone(preferred);
    if (result.status === "error") throw new Error(result.error);
    return result.data;
  }

  async quitApp(): Promise<void> {
    await commands.quitApp();
  }

  async locatePill(): Promise<void> {
    await invoke("sync_native_pill_assistant", {
      payload: JSON.stringify({ type: "locate" }),
    });
  }

  async microphoneReadinessReport(): Promise<string> {
    return commands.microphoneReadinessReport();
  }

  async captureStartupTiming(): Promise<CaptureStartupStage[]> {
    return commands.captureStartupTiming();
  }
}

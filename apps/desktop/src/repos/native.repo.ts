import { commands, NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { BaseRepo } from "./base.repo";

export abstract class BaseNativeRepo extends BaseRepo {
  abstract requestAdminRelaunch(): Promise<NativeSetupResult>;
  abstract quitApp(): Promise<void>;
}

export class LocalNativeRepo extends BaseNativeRepo {
  async requestAdminRelaunch(): Promise<NativeSetupResult> {
    return commands.requestAdminRelaunch();
  }

  async quitApp(): Promise<void> {
    await commands.quitApp();
  }
}

import { AppTarget } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

export type AppTargetUpsertParams = {
  id: string;
  name: string;
  toneId: string | null;
  iconPath: string | null;
  pasteKeybind: string | null;
  insertionMethod: string | null;
  typingSpeedMs: number | null;
};

export abstract class BaseAppTargetRepo extends BaseRepo {
  abstract listAppTargets(): Promise<AppTarget[]>;
  abstract upsertAppTarget(
    params: AppTargetUpsertParams,
    lease?: LocalDataWriteLease,
  ): Promise<AppTarget>;
}

export class LocalAppTargetRepo extends BaseAppTargetRepo {
  async listAppTargets(): Promise<AppTarget[]> {
    return invoke<AppTarget[]>("app_target_list");
  }

  upsertAppTarget(
    params: AppTargetUpsertParams,
    lease?: LocalDataWriteLease,
  ): Promise<AppTarget> {
    return withLocalDataWrite(
      () =>
        invoke<AppTarget>("app_target_upsert", {
          args: params,
        }),
      lease,
    );
  }
}

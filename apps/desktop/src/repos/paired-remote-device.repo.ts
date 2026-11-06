import type { PairedRemoteDevice } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

export type PairedRemoteDeviceUpsertParams = {
  id: string;
  name: string;
  platform: PairedRemoteDevice["platform"];
  role: PairedRemoteDevice["role"];
  sharedSecret: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastKnownAddress: string | null;
  trusted: boolean;
};

export abstract class BasePairedRemoteDeviceRepo extends BaseRepo {
  abstract listPairedRemoteDevices(): Promise<PairedRemoteDevice[]>;
  abstract upsertPairedRemoteDevice(
    params: PairedRemoteDeviceUpsertParams,
    lease?: LocalDataWriteLease,
  ): Promise<PairedRemoteDevice>;
  abstract deletePairedRemoteDevice(
    id: string,
    lease?: LocalDataWriteLease,
  ): Promise<void>;
}

export class LocalPairedRemoteDeviceRepo extends BasePairedRemoteDeviceRepo {
  async listPairedRemoteDevices(): Promise<PairedRemoteDevice[]> {
    return invoke<PairedRemoteDevice[]>("paired_remote_device_list");
  }

  upsertPairedRemoteDevice(
    params: PairedRemoteDeviceUpsertParams,
    lease?: LocalDataWriteLease,
  ): Promise<PairedRemoteDevice> {
    return withLocalDataWrite(
      () =>
        invoke<PairedRemoteDevice>("paired_remote_device_upsert", {
          args: params,
        }),
      lease,
    );
  }

  deletePairedRemoteDevice(
    id: string,
    lease?: LocalDataWriteLease,
  ): Promise<void> {
    return withLocalDataWrite(
      () =>
        invoke<void>("paired_remote_device_delete", {
          args: { id },
        }),
      lease,
    );
  }
}

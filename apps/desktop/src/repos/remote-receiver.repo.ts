import type { RemoteReceiverStatus } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

export abstract class BaseRemoteReceiverRepo extends BaseRepo {
  abstract getRemoteReceiverStatus(): Promise<RemoteReceiverStatus>;
  abstract startRemoteReceiver(
    port?: number | null,
    lease?: LocalDataWriteLease,
  ): Promise<RemoteReceiverStatus>;
  abstract stopRemoteReceiver(
    lease?: LocalDataWriteLease,
  ): Promise<RemoteReceiverStatus>;
}

export class LocalRemoteReceiverRepo extends BaseRemoteReceiverRepo {
  async getRemoteReceiverStatus(): Promise<RemoteReceiverStatus> {
    return invoke<RemoteReceiverStatus>("remote_receiver_status");
  }

  startRemoteReceiver(
    port?: number | null,
    lease?: LocalDataWriteLease,
  ): Promise<RemoteReceiverStatus> {
    return withLocalDataWrite(
      () =>
        invoke<RemoteReceiverStatus>("remote_receiver_start", {
          args: {
            port: port ?? null,
          },
        }),
      lease,
    );
  }

  stopRemoteReceiver(
    lease?: LocalDataWriteLease,
  ): Promise<RemoteReceiverStatus> {
    return withLocalDataWrite(async () => {
      await invoke<void>("remote_receiver_stop");
      return this.getRemoteReceiverStatus();
    }, lease);
  }
}

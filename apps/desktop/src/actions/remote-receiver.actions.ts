import type { Nullable, RemoteReceiverStatus } from "@maus-inc/types";
import { getRemoteReceiverRepo } from "../repos";
import { produceAppState } from "../store";
import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";

const setRemoteReceiverStatus = (
  status: Nullable<RemoteReceiverStatus>,
  lease: LocalDataWriteLease,
): void => {
  produceAppState((draft) => {
    draft.remoteReceiverStatus = status;
  }, lease);
};

export const refreshRemoteReceiverStatus =
  async (): Promise<RemoteReceiverStatus> =>
    withLocalDataWrite(async (lease) => {
      const status = await getRemoteReceiverRepo().getRemoteReceiverStatus();
      setRemoteReceiverStatus(status, lease);
      return status;
    });

export const startRemoteReceiver = async (
  port?: number | null,
): Promise<RemoteReceiverStatus> =>
  withLocalDataWrite(async (lease) => {
    const status = await getRemoteReceiverRepo().startRemoteReceiver(
      port,
      lease,
    );
    setRemoteReceiverStatus(status, lease);
    return status;
  });

export const stopRemoteReceiver = async (): Promise<RemoteReceiverStatus> =>
  withLocalDataWrite(async (lease) => {
    const status = await getRemoteReceiverRepo().stopRemoteReceiver(lease);
    setRemoteReceiverStatus(status, lease);
    return status;
  });

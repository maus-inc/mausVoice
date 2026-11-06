import type { PairedRemoteDevice } from "@maus-inc/types";
import { getPairedRemoteDeviceRepo } from "../repos";
import type { PairedRemoteDeviceUpsertParams } from "../repos/paired-remote-device.repo";
import { getAppState, produceAppState } from "../store";
import { registerPairedRemoteDevices } from "../utils/app.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { setRemoteTargetDeviceId } from "./user.actions";

export const loadPairedRemoteDevices = async (): Promise<void> =>
  withLocalDataWrite(async (lease) => {
    const devices = await getPairedRemoteDeviceRepo().listPairedRemoteDevices();

    produceAppState((draft) => {
      registerPairedRemoteDevices(draft, devices);
    }, lease);
  });

export const upsertPairedRemoteDevice = async (
  params: PairedRemoteDeviceUpsertParams,
  existingLease?: LocalDataWriteLease,
): Promise<PairedRemoteDevice> =>
  withLocalDataWrite(async (lease) => {
    const device = await getPairedRemoteDeviceRepo().upsertPairedRemoteDevice(
      params,
      lease,
    );

    produceAppState((draft) => {
      registerPairedRemoteDevices(draft, [device]);
    }, lease);

    return device;
  }, existingLease);

export const deletePairedRemoteDevice = async (
  id: string,
  existingLease?: LocalDataWriteLease,
): Promise<void> =>
  withLocalDataWrite(async (lease) => {
    const remoteTargetDeviceId =
      getMyUserPreferences(getAppState())?.remoteTargetDeviceId ?? null;

    await getPairedRemoteDeviceRepo().deletePairedRemoteDevice(id, lease);

    produceAppState((draft) => {
      delete draft.pairedRemoteDeviceById[id];
    }, lease);

    if (remoteTargetDeviceId === id) {
      await setRemoteTargetDeviceId(null, lease);
    }
  }, existingLease);

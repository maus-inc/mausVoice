import type { PairedRemoteDevice } from "@maus-inc/types";
import { getPairedRemoteDeviceRepo } from "../repos";
import type { PairedRemoteDeviceUpsertParams } from "../repos/paired-remote-device.repo";
import { getAppState, produceAppState, useAppStore } from "../store";
import { registerPairedRemoteDevices } from "../utils/app.utils";
import { getPairedRemoteDeviceById } from "../utils/device.utils";
import { updateUserPreferences } from "./user.actions";

const deviceMutations = new Map<string, Promise<void>>();
let activeDeviceLoad: { touched: Set<string>; unsubscribe: () => void } | null =
  null;

/** Serialize same-device writes, including invite pairing, without blocking other devices. */
export const enqueuePairedDeviceMutation = <T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = deviceMutations.get(id) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  deviceMutations.set(id, settled);
  void settled.then(() => {
    if (deviceMutations.get(id) === settled) deviceMutations.delete(id);
  });
  return result;
};

export const loadPairedRemoteDevices = async (): Promise<boolean> => {
  activeDeviceLoad?.unsubscribe();
  const load = { touched: new Set<string>(), unsubscribe: () => {} };
  activeDeviceLoad = load;
  load.unsubscribe = useAppStore.subscribe((current, previous) => {
    if (current.pairedRemoteDeviceById === previous.pairedRemoteDeviceById)
      return;
    for (const id of new Set([
      ...Object.keys(previous.pairedRemoteDeviceById),
      ...Object.keys(current.pairedRemoteDeviceById),
    ])) {
      if (
        previous.pairedRemoteDeviceById[id] !==
        current.pairedRemoteDeviceById[id]
      )
        load.touched.add(id);
    }
  });
  try {
    const devices = await getPairedRemoteDeviceRepo().listPairedRemoteDevices();
    if (activeDeviceLoad !== load) return false;
    const current = getAppState().pairedRemoteDeviceById;
    const merged = new Map(devices.map((device) => [device.id, device]));
    for (const id of load.touched) {
      if (Object.hasOwn(current, id)) merged.set(id, current[id]);
      else merged.delete(id);
    }
    produceAppState((draft) => {
      draft.pairedRemoteDeviceById = Object.fromEntries(merged);
    });
    return true;
  } finally {
    load.unsubscribe();
    if (activeDeviceLoad === load) activeDeviceLoad = null;
  }
};

export const upsertPairedRemoteDevice = (
  params: PairedRemoteDeviceUpsertParams,
): Promise<PairedRemoteDevice> =>
  enqueuePairedDeviceMutation(params.id, async () => {
    const device =
      await getPairedRemoteDeviceRepo().upsertPairedRemoteDevice(params);
    activeDeviceLoad?.touched.add(device.id);
    produceAppState((draft) => {
      registerPairedRemoteDevices(draft, [device]);
    });
    return device;
  });

export const deletePairedRemoteDevice = (
  id: string,
  options: { replacementId?: string } = {},
): Promise<void> =>
  enqueuePairedDeviceMutation(id, async () => {
    await getPairedRemoteDeviceRepo().deletePairedRemoteDevice(id);
    activeDeviceLoad?.touched.add(id);
    produceAppState((draft) => {
      delete draft.pairedRemoteDeviceById[id];
    });
    await updateUserPreferences(
      (prefs) => {
        const replacement = getPairedRemoteDeviceById(
          getAppState(),
          options.replacementId ?? null,
        );
        if (
          replacement &&
          (replacement.role === "receiver" || replacement.role === "both")
        ) {
          prefs.remoteTargetDeviceId = replacement.id;
        } else {
          prefs.remoteTargetDeviceId = null;
          prefs.remoteOutputEnabled = false;
        }
      },
      "Failed to save paired receiver selection. Please try again.",
      (prefs) =>
        prefs.remoteTargetDeviceId === id &&
        !getPairedRemoteDeviceById(getAppState(), id),
    );
  });

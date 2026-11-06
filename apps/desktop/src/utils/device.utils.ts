import type {
  PairedRemoteDevice,
  RemoteOutputPreferences,
} from "@maus-inc/types";
import type { AppState } from "../state/app.state";

export const getPairedRemoteDeviceById = (
  state: AppState,
  deviceId: string | null,
): PairedRemoteDevice | null => {
  if (!deviceId) {
    return null;
  }

  return Object.hasOwn(state.pairedRemoteDeviceById, deviceId)
    ? (state.pairedRemoteDeviceById[deviceId] ?? null)
    : null;
};

export const canReceiveRemoteOutput = (device: PairedRemoteDevice): boolean =>
  device.role === "receiver" || device.role === "both";

export const listPairedRemoteDevices = (
  state: AppState,
): PairedRemoteDevice[] => {
  return Object.values(state.pairedRemoteDeviceById).sort((left, right) =>
    right.pairedAt.localeCompare(left.pairedAt),
  );
};

const getRemoteOutputPreferences = (
  state: AppState,
): RemoteOutputPreferences => {
  return {
    remoteOutputEnabled: state.userPrefs?.remoteOutputEnabled ?? false,
    remoteTargetDeviceId: state.userPrefs?.remoteTargetDeviceId ?? null,
  };
};

export const getRemoteReceiverStatus = (
  state: AppState,
): AppState["remoteReceiverStatus"] => {
  return state.remoteReceiverStatus;
};

export const getActiveRemoteTarget = (
  state: AppState,
): PairedRemoteDevice | null => {
  const prefs = getRemoteOutputPreferences(state);
  return getPairedRemoteDeviceById(state, prefs.remoteTargetDeviceId);
};

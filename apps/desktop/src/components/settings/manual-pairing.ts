import type {
  PairedRemoteDevice,
  RemoteDevicePlatform,
  RemoteDeviceRole,
} from "@maus-inc/types";
import {
  deletePairedRemoteDevice,
  upsertPairedRemoteDevice,
} from "../../actions/paired-remote-device.actions";

export type PairForm = {
  name: string;
  deviceId: string;
  address: string;
  secret: string;
  platform: RemoteDevicePlatform;
  role: RemoteDeviceRole;
};

export const validateManualPair = (
  form: PairForm,
):
  | { ok: true; pair: Omit<PairForm, "address"> & { address: string | null } }
  | { ok: false; error: string } => {
  const name = form.name.trim();
  const deviceId = form.deviceId.trim();
  const address = form.address.trim();
  const secret = form.secret.trim();
  const requiresAddress = form.role !== "sender";
  if (!name || !deviceId || !secret || (requiresAddress && !address)) {
    return {
      ok: false,
      error: requiresAddress
        ? "Name, device ID, receiver address, and shared secret are required."
        : "Name, device ID, and shared secret are required.",
    };
  }
  return {
    ok: true,
    pair: {
      name,
      deviceId,
      address: requiresAddress ? address : null,
      secret,
      platform: form.platform,
      role: form.role,
    },
  };
};

export const saveManualPair = async ({
  pair,
  pairedDevices,
  editingDeviceId,
}: {
  pair: Omit<PairForm, "address"> & { address: string | null };
  pairedDevices: PairedRemoteDevice[];
  editingDeviceId: string | null;
}): Promise<void> => {
  const existing = pairedDevices.find(
    (device) => device.id === (editingDeviceId ?? pair.deviceId),
  );
  // Save first so a failed upsert never deletes the old pairing and its secret.
  await upsertPairedRemoteDevice({
    id: pair.deviceId,
    name: pair.name,
    platform: pair.platform,
    role: pair.role,
    sharedSecret: pair.secret,
    pairedAt: existing?.pairedAt ?? new Date().toISOString(),
    lastSeenAt: existing?.lastSeenAt ?? null,
    lastKnownAddress: pair.address,
    trusted: existing?.trusted ?? true,
  });
  if (!editingDeviceId || editingDeviceId === pair.deviceId) return;

  await deletePairedRemoteDevice(editingDeviceId, {
    replacementId: pair.deviceId,
  });
};

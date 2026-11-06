import type {
  PairedRemoteDevice,
  RemoteDevicePlatform,
  RemoteReceiverStatus,
} from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { getAppState, produceAppState, useAppStore } from "../store";
import { registerPairedRemoteDevices } from "../utils/app.utils";
import { getPairedRemoteDeviceById } from "../utils/device.utils";
import { getPlatform } from "../utils/platform.utils";
import { enqueuePairedDeviceMutation } from "./paired-remote-device.actions";
import { updateUserPreferences } from "./user.actions";

const INVITE_PREFIX = "mausvoice-pair:";

type RemotePairingInvite = {
  version: 1;
  receiverDeviceId: string;
  receiverDeviceName: string;
  receiverPlatform: RemoteDevicePlatform;
  receiverAddress: string;
  pairingCode: string;
};

const getCurrentRemoteDevicePlatform = (): RemoteDevicePlatform => {
  const platform = getPlatform();
  if (platform === "macos" || platform === "windows") {
    return platform;
  }
  throw new Error("Remote pairing is only supported on macOS and Windows.");
};

const encodeBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export const buildRemotePairingInvite = (
  status: RemoteReceiverStatus,
): string | null => {
  if (!status.enabled || !status.listenAddress || !status.port) {
    return null;
  }

  const invite: RemotePairingInvite = {
    version: 1,
    receiverDeviceId: status.deviceId,
    receiverDeviceName: status.deviceName,
    receiverPlatform:
      (
        status as RemoteReceiverStatus & {
          devicePlatform?: RemoteDevicePlatform;
        }
      ).devicePlatform ?? getCurrentRemoteDevicePlatform(),
    receiverAddress: `${status.listenAddress}:${status.port}`,
    pairingCode: status.pairingCode,
  };

  return `${INVITE_PREFIX}${encodeBase64Url(JSON.stringify(invite))}`;
};

const parseRemotePairingInvite = (value: string): RemotePairingInvite => {
  const trimmed = value.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) {
    throw new Error("Pair code is not a valid mausVoice remote invite.");
  }

  const decoded = decodeBase64Url(trimmed.slice(INVITE_PREFIX.length));
  const invite = JSON.parse(decoded) as RemotePairingInvite;
  if (
    invite.version !== 1 ||
    !invite.receiverDeviceId ||
    !invite.receiverDeviceName ||
    !invite.receiverPlatform ||
    !invite.receiverAddress ||
    !invite.pairingCode
  ) {
    throw new Error("Pair code is missing required receiver information.");
  }

  return invite;
};

export const pairWithRemoteInvite = async (
  inviteCode: string,
): Promise<PairedRemoteDevice> => {
  const invite = parseRemotePairingInvite(inviteCode);
  const preferences = getAppState().userPrefs;
  const previousTargetId = preferences?.remoteTargetDeviceId ?? null;
  const previousEnabled = preferences?.remoteOutputEnabled ?? false;
  let selectionChanged = false;
  const unsubscribe = useAppStore.subscribe((current, previous) => {
    if (
      current.userPrefs?.remoteTargetDeviceId !==
        previous.userPrefs?.remoteTargetDeviceId ||
      current.userPrefs?.remoteOutputEnabled !==
        previous.userPrefs?.remoteOutputEnabled
    )
      selectionChanged = true;
  });
  try {
    const device = await enqueuePairedDeviceMutation(
      invite.receiverDeviceId,
      async () => {
        const paired = await invoke<PairedRemoteDevice>(
          "remote_sender_pair_with_receiver",
          {
            args: {
              receiverDeviceId: invite.receiverDeviceId,
              receiverName: invite.receiverDeviceName,
              receiverPlatform: invite.receiverPlatform,
              receiverAddress: invite.receiverAddress,
              pairingCode: invite.pairingCode,
            },
          },
        );
        produceAppState((draft) => {
          registerPairedRemoteDevices(draft, [paired]);
        });
        return paired;
      },
    );
    await updateUserPreferences(
      (prefs) => {
        prefs.remoteTargetDeviceId = device.id;
        prefs.remoteOutputEnabled = true;
      },
      "Failed to save paired receiver selection. Please try again.",
      (prefs) => {
        const current = getPairedRemoteDeviceById(getAppState(), device.id);
        return (
          !selectionChanged &&
          prefs.remoteTargetDeviceId === previousTargetId &&
          prefs.remoteOutputEnabled === previousEnabled &&
          current?.sharedSecret === device.sharedSecret &&
          current.trusted &&
          (current.role === "receiver" || current.role === "both")
        );
      },
    );
    return device;
  } finally {
    unsubscribe();
  }
};

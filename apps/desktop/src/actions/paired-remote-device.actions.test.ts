import type {
  PairedRemoteDevice,
  RemoteReceiverStatus,
  UserPreferences,
} from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  setPreferences: vi.fn(),
  getPreferences: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("../repos", () => ({
  getPairedRemoteDeviceRepo: () => ({
    listPairedRemoteDevices: mocks.list,
    upsertPairedRemoteDevice: mocks.upsert,
    deletePairedRemoteDevice: mocks.remove,
  }),
  getUserPreferencesRepo: () => ({
    setUserPreferences: mocks.setPreferences,
    getUserPreferences: mocks.getPreferences,
  }),
  getUserRepo: () => ({}),
}));
vi.mock("./app.actions", () => ({
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    verbose: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  clearUnavailableRemoteTarget,
  createDefaultPreferences,
  setRemoteTargetDeviceId,
} from "./user.actions";
import { getPairedRemoteDeviceById } from "../utils/device.utils";
import {
  deletePairedRemoteDevice,
  loadPairedRemoteDevices,
  upsertPairedRemoteDevice,
} from "./paired-remote-device.actions";
import {
  buildRemotePairingInvite,
  pairWithRemoteInvite,
} from "./remote-pairing.actions";
import { saveManualPair } from "../components/settings/manual-pairing";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const device = (id: string): PairedRemoteDevice => ({
  id,
  name: id,
  platform: "windows",
  role: "receiver",
  sharedSecret: `secret-${id}`,
  pairedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  lastKnownAddress: "127.0.0.1:1234",
  trusted: true,
});
const receiverStatus: RemoteReceiverStatus = {
  enabled: true,
  deviceId: "new",
  deviceName: "New",
  devicePlatform: "windows",
  listenAddress: "127.0.0.1",
  port: 1234,
  pairingCode: "pairing-code",
  lastSenderDeviceId: null,
  lastEventId: null,
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
  lastError: null,
  lastTargetClassName: null,
  lastTargetTitle: null,
  lastTargetEditable: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  const state = structuredClone(INITIAL_APP_STATE);
  state.pairedRemoteDeviceById = { old: device("old"), other: device("other") };
  state.userPrefs = {
    ...createDefaultPreferences(),
    remoteTargetDeviceId: "old",
    remoteOutputEnabled: true,
  };
  setAppState(state, true);
  mocks.setPreferences.mockImplementation(
    async (prefs: UserPreferences) => prefs,
  );
  mocks.getPreferences.mockResolvedValue(null);
  mocks.remove.mockResolvedValue(undefined);
  mocks.upsert.mockImplementation(async (value: PairedRemoteDevice) => value);
});

describe("paired device ownership", () => {
  it("does not clear a newer target when an older device deletion completes", async () => {
    const deleting = deferred<void>();
    mocks.remove.mockReturnValueOnce(deleting.promise);
    const pending = deletePairedRemoteDevice("old");
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
    await setRemoteTargetDeviceId("other");
    deleting.resolve();
    await pending;
    expect(getAppState().userPrefs).toMatchObject({
      remoteTargetDeviceId: "other",
      remoteOutputEnabled: true,
    });
    expect(getAppState().pairedRemoteDeviceById.old).toBeUndefined();
    expect(mocks.setPreferences).toHaveBeenCalledOnce();
  });

  it("serializes a deletion and an upsert for the same device", async () => {
    const deleting = deferred<void>();
    mocks.remove.mockReturnValueOnce(deleting.promise);
    const removed = deletePairedRemoteDevice("old");
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
    const replacement = { ...device("old"), name: "Replacement" };
    const saved = upsertPairedRemoteDevice(replacement);
    expect(mocks.upsert).not.toHaveBeenCalled();
    deleting.resolve();
    await Promise.all([removed, saved]);
    expect(getAppState().pairedRemoteDeviceById.old.name).toBe("Replacement");
    expect(getAppState().userPrefs).toMatchObject({
      remoteTargetDeviceId: null,
      remoteOutputEnabled: false,
    });
  });

  it("does not resurrect a device deleted while an older list request is pending", async () => {
    const read = deferred<PairedRemoteDevice[]>();
    mocks.list.mockReturnValueOnce(read.promise);
    const loading = loadPairedRemoteDevices();
    await deletePairedRemoteDevice("old");
    read.resolve([device("old"), device("other")]);
    await loading;
    expect(getAppState().pairedRemoteDeviceById.old).toBeUndefined();
    expect(getAppState().pairedRemoteDeviceById.other).toEqual(device("other"));
  });

  it("removes records that are absent from the latest persisted list", async () => {
    mocks.list.mockResolvedValueOnce([device("other")]);
    await loadPairedRemoteDevices();
    expect(getAppState().pairedRemoteDeviceById.old).toBeUndefined();
  });

  it("preserves a newer target when a manual rename finishes late", async () => {
    const deleting = deferred<void>();
    mocks.remove.mockReturnValueOnce(deleting.promise);
    const renamed = saveManualPair({
      pair: {
        name: "New",
        deviceId: "new",
        address: "127.0.0.1:1234",
        secret: "secret-new",
        platform: "windows",
        role: "receiver",
      },
      pairedDevices: [device("old"), device("other")],
      editingDeviceId: "old",
    });
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("old"));
    await setRemoteTargetDeviceId("other");
    deleting.resolve();
    await renamed;
    expect(getAppState().userPrefs).toMatchObject({
      remoteTargetDeviceId: "other",
      remoteOutputEnabled: true,
    });
    expect(getAppState().pairedRemoteDeviceById.new).toBeDefined();
  });

  it.each([true, false])(
    "moves a renamed target without changing enabled=%s",
    async (enabled) => {
      setAppState({
        userPrefs: {
          ...getAppState().userPrefs!,
          remoteOutputEnabled: enabled,
        },
      });
      await saveManualPair({
        pair: {
          name: "New",
          deviceId: "new",
          address: "127.0.0.1:1234",
          secret: "secret-new",
          platform: "windows",
          role: "receiver",
        },
        pairedDevices: [device("old")],
        editingDeviceId: "old",
      });
      expect(getAppState().userPrefs).toMatchObject({
        remoteTargetDeviceId: "new",
        remoteOutputEnabled: enabled,
      });
    },
  );

  it("selects a successfully paired receiver when the output decision is unchanged", async () => {
    mocks.invoke.mockResolvedValueOnce(device("new"));
    const invite = buildRemotePairingInvite(receiverStatus);
    if (!invite) throw new Error("Missing invite");
    await pairWithRemoteInvite(invite);
    expect(getAppState().userPrefs).toMatchObject({
      remoteTargetDeviceId: "new",
      remoteOutputEnabled: true,
    });
  });

  it("does not override a newer output decision when invite pairing completes late", async () => {
    const pending = deferred<PairedRemoteDevice>();
    mocks.invoke.mockReturnValueOnce(pending.promise);
    const invite = buildRemotePairingInvite(receiverStatus);
    if (!invite) throw new Error("Missing invite");
    const pairing = pairWithRemoteInvite(invite);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    await setRemoteTargetDeviceId("other");
    pending.resolve(device("new"));
    await pairing;
    expect(getAppState().userPrefs).toMatchObject({
      remoteTargetDeviceId: "other",
      remoteOutputEnabled: true,
    });
    expect(getAppState().pairedRemoteDeviceById.new).toBeDefined();
  });

  it("ignores an older list response after a newer load finishes", async () => {
    const first = deferred<PairedRemoteDevice[]>();
    const second = deferred<PairedRemoteDevice[]>();
    mocks.list
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const oldLoad = loadPairedRemoteDevices();
    const newLoad = loadPairedRemoteDevices();
    second.resolve([device("other")]);
    expect(await newLoad).toBe(true);
    first.resolve([device("old")]);
    expect(await oldLoad).toBe(false);
    expect(Object.keys(getAppState().pairedRemoteDeviceById)).toEqual([
      "other",
    ]);
  });

  it("does not resurrect a deleted record that was absent from memory", async () => {
    setAppState({ pairedRemoteDeviceById: {} });
    const read = deferred<PairedRemoteDevice[]>();
    mocks.list.mockReturnValueOnce(read.promise);
    const loading = loadPairedRemoteDevices();
    await deletePairedRemoteDevice("old");
    read.resolve([device("old")]);
    await loading;
    expect(getAppState().pairedRemoteDeviceById.old).toBeUndefined();
  });

  it("does not poison the same-device queue after a failed mutation", async () => {
    mocks.upsert.mockRejectedValueOnce(new Error("failed"));
    const failed = upsertPairedRemoteDevice(device("old"));
    const next = upsertPairedRemoteDevice({
      ...device("old"),
      name: "Recovered",
    });
    await expect(failed).rejects.toThrow("failed");
    await next;
    expect(getAppState().pairedRemoteDeviceById.old.name).toBe("Recovered");
  });

  it("does not block writes to other devices", async () => {
    const deleting = deferred<void>();
    mocks.remove.mockReturnValueOnce(deleting.promise);
    const pending = deletePairedRemoteDevice("old");
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
    await upsertPairedRemoteDevice({ ...device("other"), name: "Updated" });
    expect(getAppState().pairedRemoteDeviceById.other.name).toBe("Updated");
    deleting.resolve();
    await pending;
  });

  it("serializes invite pairing and deletion for the same device", async () => {
    const result = deferred<PairedRemoteDevice>();
    mocks.invoke.mockReturnValueOnce(result.promise);
    const invite = buildRemotePairingInvite(receiverStatus);
    if (!invite) throw new Error("Missing invite");
    const pairing = pairWithRemoteInvite(invite);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    const deletion = deletePairedRemoteDevice("new");
    expect(mocks.remove).not.toHaveBeenCalled();
    result.resolve(device("new"));
    await Promise.all([pairing, deletion]);
    expect(getAppState().pairedRemoteDeviceById.new).toBeUndefined();
    expect(getAppState().userPrefs?.remoteTargetDeviceId).not.toBe("new");
  });

  it("preserves a selection changed away and back during invite pairing", async () => {
    const result = deferred<PairedRemoteDevice>();
    mocks.invoke.mockReturnValueOnce(result.promise);
    const invite = buildRemotePairingInvite(receiverStatus);
    if (!invite) throw new Error("Missing invite");
    const pairing = pairWithRemoteInvite(invite);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    await setRemoteTargetDeviceId("other");
    await setRemoteTargetDeviceId("old");
    result.resolve(device("new"));
    await pairing;
    expect(getAppState().userPrefs?.remoteTargetDeviceId).toBe("old");
  });

  it("stores prototype-shaped device IDs as own records and deletes them safely", async () => {
    const unusual = device("__proto__");
    await upsertPairedRemoteDevice(unusual);
    expect(
      Object.hasOwn(getAppState().pairedRemoteDeviceById, unusual.id),
    ).toBe(true);
    expect(getPairedRemoteDeviceById(getAppState(), unusual.id)).toEqual(
      unusual,
    );
    await deletePairedRemoteDevice(unusual.id);
    expect(
      Object.hasOwn(getAppState().pairedRemoteDeviceById, unusual.id),
    ).toBe(false);
    expect(getPairedRemoteDeviceById(getAppState(), unusual.id)).toBeNull();
  });

  it("does not mistake inherited object properties for paired devices", async () => {
    setAppState({
      userPrefs: {
        ...getAppState().userPrefs!,
        remoteTargetDeviceId: "constructor",
        remoteOutputEnabled: true,
      },
    });
    expect(getPairedRemoteDeviceById(getAppState(), "constructor")).toBeNull();
    await clearUnavailableRemoteTarget(() => true);
    expect(getAppState().userPrefs).toMatchObject({
      remoteTargetDeviceId: null,
      remoteOutputEnabled: false,
    });
  });
});

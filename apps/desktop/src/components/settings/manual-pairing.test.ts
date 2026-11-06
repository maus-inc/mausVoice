import type { PairedRemoteDevice } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveManualPair,
  validateManualPair,
  type PairForm,
} from "./manual-pairing";

const actions = vi.hoisted(() => ({
  upsert: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../actions/paired-remote-device.actions", () => ({
  upsertPairedRemoteDevice: actions.upsert,
  deletePairedRemoteDevice: actions.remove,
}));

const form: PairForm = {
  name: " New name ",
  deviceId: " new-id ",
  address: " 192.168.1.8 ",
  secret: " secret ",
  role: "receiver",
  platform: "macos",
};
const oldDevice: PairedRemoteDevice = {
  id: "old-id",
  name: "Old name",
  platform: "windows",
  role: "receiver",
  sharedSecret: "old secret",
  pairedAt: "2024-01-01T00:00:00.000Z",
  lastSeenAt: "2024-02-01T00:00:00.000Z",
  lastKnownAddress: "old address",
  trusted: false,
};

const parsed = () => {
  const result = validateManualPair(form);
  if (!result.ok) throw new Error(result.error);
  return result.pair;
};

beforeEach(() => {
  vi.resetAllMocks();
  actions.upsert.mockResolvedValue(undefined);
  actions.remove.mockResolvedValue(undefined);
});

describe("manual pairing", () => {
  it.each(["name", "deviceId", "secret", "address"] as const)(
    "rejects an empty receiver %s",
    (field) => {
      expect(validateManualPair({ ...form, [field]: "  " })).toEqual({
        ok: false,
        error:
          "Name, device ID, receiver address, and shared secret are required.",
      });
    },
  );

  it("accepts a sender without an address and keeps the sender-specific error", () => {
    const sender = { ...form, role: "sender" as const, address: " " };
    expect(validateManualPair(sender)).toEqual({
      ok: true,
      pair: {
        name: "New name",
        deviceId: "new-id",
        address: null,
        secret: "secret",
        role: "sender",
        platform: "macos",
      },
    });
    expect(validateManualPair({ ...sender, name: " " })).toEqual({
      ok: false,
      error: "Name, device ID, and shared secret are required.",
    });
  });

  it("preserves the receiver address for a both-role device", () => {
    expect(validateManualPair({ ...form, role: "both", address: "" })).toEqual({
      ok: false,
      error:
        "Name, device ID, receiver address, and shared secret are required.",
    });
    expect(validateManualPair({ ...form, role: "both" })).toEqual({
      ok: true,
      pair: {
        name: "New name",
        deviceId: "new-id",
        address: "192.168.1.8",
        secret: "secret",
        role: "both",
        platform: "macos",
      },
    });
  });

  it("requests a conditional target replacement when a device is renamed", async () => {
    const calls: string[] = [];
    actions.upsert.mockImplementation(async () => {
      calls.push("upsert");
    });
    actions.remove.mockImplementation(async () => {
      calls.push("delete");
    });
    await saveManualPair({
      pair: parsed(),
      pairedDevices: [oldDevice],
      editingDeviceId: "old-id",
    });
    expect(actions.upsert).toHaveBeenCalledWith({
      id: "new-id",
      name: "New name",
      platform: "macos",
      role: "receiver",
      sharedSecret: "secret",
      pairedAt: oldDevice.pairedAt,
      lastSeenAt: oldDevice.lastSeenAt,
      lastKnownAddress: "192.168.1.8",
      trusted: false,
    });
    expect(actions.remove).toHaveBeenCalledWith("old-id", {
      replacementId: "new-id",
    });
    expect(calls).toEqual(["upsert", "delete"]);
  });

  it("delegates target replacement to the device deletion action", async () => {
    await saveManualPair({
      pair: parsed(),
      pairedDevices: [oldDevice],
      editingDeviceId: "old-id",
    });
    expect(actions.remove).toHaveBeenCalledWith("old-id", {
      replacementId: "new-id",
    });
  });

  it("updates an existing device without deleting it", async () => {
    await saveManualPair({
      pair: { ...parsed(), deviceId: "old-id" },
      pairedDevices: [oldDevice],
      editingDeviceId: "old-id",
    });
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it("creates a new device with default metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-05-01T00:00:00.000Z"));
    try {
      await saveManualPair({
        pair: parsed(),
        pairedDevices: [],
        editingDeviceId: null,
      });
      expect(actions.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          pairedAt: "2025-05-01T00:00:00.000Z",
          lastSeenAt: null,
          trusted: true,
        }),
      );
      expect(actions.remove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["upsert", "remove"] as const)(
    "stops after %s fails",
    async (step) => {
      const error = new Error(`${step} failed`);
      actions[step].mockRejectedValue(error);
      await expect(
        saveManualPair({
          pair: parsed(),
          pairedDevices: [oldDevice],
          editingDeviceId: "old-id",
        }),
      ).rejects.toBe(error);
      if (step === "upsert") expect(actions.remove).not.toHaveBeenCalled();
    },
  );
});

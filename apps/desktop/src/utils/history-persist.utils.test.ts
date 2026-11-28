import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./log.utils", () => ({
  getLogger: () => ({
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
  }),
}));

import {
  enqueueHistoryPersist,
  flushHistoryPersist,
  MAX_HISTORY_PERSIST_QUEUE,
  resetHistoryPersistQueue,
  shouldPersistBeforeDelivery,
  snapshotStopRecordingAudio,
  type PersistBeforeDeliveryInput,
} from "./history-persist.utils";

afterEach(() => {
  resetHistoryPersistQueue();
});

describe("snapshotStopRecordingAudio", () => {
  it("copies a Float32Array so later mutation cannot alias the persist payload", () => {
    const samples = new Float32Array([0.1, 0.2]);
    const snapshot = snapshotStopRecordingAudio({
      samples,
      sampleRate: 16_000,
    });
    samples[0] = 9;
    expect(snapshot.samples[0]).toBeCloseTo(0.1);
    expect(snapshot.samples).not.toBe(samples);
  });

  it("copies a number array", () => {
    const samples = [0.3, 0.4];
    const snapshot = snapshotStopRecordingAudio({ samples, sampleRate: 8_000 });
    samples[0] = 9;
    expect(snapshot.samples[0]).toBe(0.3);
  });
});

describe("enqueueHistoryPersist", () => {
  it("does not start the next job until the previous one settles", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = enqueueHistoryPersist(
      () =>
        new Promise<void>((resolve) => {
          order.push("first-start");
          releaseFirst = () => {
            order.push("first-end");
            resolve();
          };
        }),
      "first",
    );
    enqueueHistoryPersist(() => {
      order.push("second-start");
      return Promise.resolve();
    }, "second");

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await first;
    await flushHistoryPersist();
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("lets an awaited caller observe a rejection instead of swallowing it", async () => {
    const failure = new Error("wav failed");
    const pending = enqueueHistoryPersist(
      () => Promise.reject(failure),
      "awaited",
      { awaited: true },
    );
    await expect(pending).rejects.toBe(failure);
  });

  it("rejects a new job when the queue is already full", async () => {
    const hang = () => new Promise<void>(() => undefined);
    for (let i = 0; i < MAX_HISTORY_PERSIST_QUEUE; i += 1) {
      const pending = enqueueHistoryPersist(hang, `job-${i}`);
      pending.catch(() => undefined);
    }
    await expect(
      enqueueHistoryPersist(() => Promise.resolve(), "overflow"),
    ).rejects.toThrow(/queue full/);
    resetHistoryPersistQueue();
  });

  it("still runs a later job after an earlier rejection", async () => {
    const order: string[] = [];
    enqueueHistoryPersist(() => {
      order.push("fail");
      return Promise.reject(new Error("wav failed"));
    }, "fail");
    enqueueHistoryPersist(() => {
      order.push("next");
      return Promise.resolve();
    }, "next");
    await flushHistoryPersist();
    expect(order).toEqual(["fail", "next"]);
  });
});

describe("shouldPersistBeforeDelivery", () => {
  const allowed: PersistBeforeDeliveryInput = {
    hasPersistenceHook: true,
    reviewBeforeInsert: false,
    remoteDeviceId: null,
    insertionMethod: "paste",
    handsFreeDelayMs: 0,
    activeSimulatedTypingCount: 0,
    queueFull: false,
  };

  it("starts the write during delivery when nothing can still change the row", () => {
    expect(shouldPersistBeforeDelivery(allowed)).toBe(true);
  });

  it.each([
    ["no persistence hook", { hasPersistenceHook: false }],
    ["review-before-insert is on", { reviewBeforeInsert: true }],
    ["a remote target is paired", { remoteDeviceId: "device-1" }],
    ["delivery is simulated typing", { insertionMethod: "type" }],
    ["a hands-free delay holds delivery", { handsFreeDelayMs: 1 }],
    [
      "a simulated typing route is in flight",
      { activeSimulatedTypingCount: 1 },
    ],
    ["the persist queue is full", { queueFull: true }],
  ])("keeps the serial path when %s", (_label, override) => {
    expect(shouldPersistBeforeDelivery({ ...allowed, ...override })).toBe(
      false,
    );
  });

  it("treats a zero hands-free delay as no delay", () => {
    expect(
      shouldPersistBeforeDelivery({ ...allowed, handsFreeDelayMs: 0 }),
    ).toBe(true);
  });
});

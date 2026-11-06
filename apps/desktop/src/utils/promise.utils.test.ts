import { beforeEach, describe, expect, it, vi } from "vitest";

const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }));

vi.mock("./log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: warningMock,
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

import { logOnRejection, startAsPromise } from "./promise.utils";

beforeEach(() => {
  warningMock.mockClear();
});

describe("logOnRejection", () => {
  it("converts a rejection into a logged warning (no unhandled rejection)", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      logOnRejection(Promise.reject(new Error("boom")), "saving the toggle");
      await Promise.resolve();
      await Promise.resolve();
      expect(warningMock).toHaveBeenCalledTimes(1);
      expect(warningMock.mock.calls[0]?.[0]).toContain("saving the toggle");
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("leaves fulfilled promises alone", async () => {
    logOnRejection(Promise.resolve("ok"), "idle path");
    await Promise.resolve();
    await Promise.resolve();
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("produces no secondary rejection when the logger itself throws", async () => {
    warningMock.mockImplementationOnce(() => {
      throw new Error("log bridge down");
    });
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      logOnRejection(Promise.reject(new Error("boom")), "crashy logger path");
      await Promise.resolve();
      await Promise.resolve();
      expect(warningMock).toHaveBeenCalledTimes(1);
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

describe("startAsPromise", () => {
  it("starts the work synchronously and resolves with its value", async () => {
    const order: string[] = [];
    const promise = startAsPromise(async () => {
      order.push("started");
      return 7;
    });
    order.push("returned");
    await expect(promise).resolves.toBe(7);
    expect(order).toEqual(["started", "returned"]);
  });

  it("turns a synchronous throw into a rejection instead of throwing", async () => {
    const boom = new Error("boom");
    let promise: Promise<never> | undefined;
    expect(() => {
      promise = startAsPromise<never>(() => {
        throw boom;
      });
    }).not.toThrow();
    await expect(promise).rejects.toBe(boom);
  });

  it("adopts the returned promise rather than wrapping it twice", async () => {
    const inner = Promise.reject(new Error("inner"));
    const outer = startAsPromise(() => inner);
    await expect(outer).rejects.toThrow("inner");
  });
});

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

import { logOnRejection } from "./promise.utils";

beforeEach(() => {
  warningMock.mockClear();
});

describe("logOnRejection", () => {
  it("converts a rejection into a logged warning (no unhandled rejection)", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      logOnRejection(Promise.reject(new Error("boom")), "saving the toggle");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(warningMock).toHaveBeenCalledTimes(1);
      expect(warningMock.mock.calls[0]?.[0]).toContain("saving the toggle");
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("leaves fulfilled promises alone", async () => {
    logOnRejection(Promise.resolve("ok"), "idle path");
    await new Promise((resolve) => setTimeout(resolve, 10));
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(warningMock).toHaveBeenCalledTimes(1);
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

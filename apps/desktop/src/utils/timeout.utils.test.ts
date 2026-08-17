import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./timeout.utils";

const never = () => new Promise<never>(() => {});

describe("withTimeout", () => {
  it("resolves with the wrapped value when it settles first", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "ok")).resolves.toBe(42);
  });

  it("rejects with a timeout error when the wrapped promise hangs", async () => {
    await expect(withTimeout(never(), 10, "hang")).rejects.toThrow(
      "hang timed out after 10ms",
    );
  });

  it("invokes onTimeout when the timeout fires", async () => {
    const onTimeout = vi.fn();
    await expect(
      withTimeout(never(), 10, "cancel", onTimeout),
    ).rejects.toThrow();
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("still rejects with the timeout error when onTimeout throws", async () => {
    const onTimeout = vi.fn(() => {
      throw new Error("cleanup boom");
    });
    await expect(
      withTimeout(never(), 10, "throwy", onTimeout),
    ).rejects.toThrow("throwy timed out after 10ms");
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});

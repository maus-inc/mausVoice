import { describe, expect, it, vi } from "vitest";
import { retry } from "./async";

describe("retry", () => {
  it("returns the first successful result", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retry({ fn, retries: 3, delay: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure while isRetryable stays true", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    await expect(
      retry({ fn, retries: 3, delay: 1, isRetryable: () => true }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not call fn again when isRetryable becomes false during the delay", async () => {
    vi.useFakeTimers();
    try {
      let retryable = true;
      const fn = vi.fn().mockRejectedValue(new Error("transient"));
      const promise = retry({
        fn,
        retries: 3,
        delay: 40,
        isRetryable: () => retryable,
      });
      // Attach the rejection handler before advancing virtual time so Vitest
      // never observes the expected failure as an unhandled rejection.
      const rejected = expect(promise).rejects.toThrow("transient");
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      retryable = false;
      await vi.advanceTimersByTimeAsync(40);
      await rejected;
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    let retryable = true;
    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    const promise = retry({
      fn,
      retries: 3,
      delay: 40,
      isRetryable: () => retryable,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    retryable = false;
    await expect(promise).rejects.toThrow("transient");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

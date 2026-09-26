import { describe, expect, it, vi } from "vitest";
import { delayed, retry } from "./async";
import { HttpError, MAX_RETRY_AFTER_MS, toHttpError } from "./http-error";

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

describe("retry HTTP status policy", () => {
  it("attempts a 402 exactly once", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new HttpError(402, "402 Payment Required"));

    await expect(retry({ fn, delay: 1 })).rejects.toThrow(
      "402 Payment Required",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("attempts a 402 exactly once even when the SDK error is not an HttpError", async () => {
    // The OpenAI, Groq, DeepSeek, Claude, and Cerebras SDKs raise APIError
    // with a numeric `status` and no Retry-After hint.
    const fn = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("401 status code (no body)"), { status: 401 }),
      );

    await expect(retry({ fn, delay: 1 })).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries every terminal client status exactly once", async () => {
    for (const status of [400, 401, 402, 403, 404, 422]) {
      const fn = vi.fn().mockRejectedValue(new HttpError(status, `${status}`));
      await expect(retry({ fn, delay: 1 })).rejects.toThrow(String(status));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("waits for the Retry-After hint on a 429", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          new HttpError(429, "Too Many Requests", { retryAfter: "1" }),
        )
        .mockResolvedValueOnce("ok");
      const promise = retry({ fn, delay: 1 });
      const settled = expect(promise).resolves.toBe("ok");

      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never waits longer than the Retry-After cap", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          new HttpError(503, "Service Unavailable", { retryAfter: "3600" }),
        )
        .mockResolvedValueOnce("ok");
      const promise = retry({ fn, delay: 1 });
      const settled = expect(promise).resolves.toBe("ok");

      await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 1);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still retries a 500 to the limit", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(500, "boom"));

    await expect(retry({ fn, delay: 1, retries: 3 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("lets a caller opt back in to retrying a terminal status", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(400, "bad request"));

    await expect(
      retry({ fn, delay: 1, retries: 2, retryTerminalStatuses: true }),
    ).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps a narrowing caller predicate authoritative", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(503, "overloaded"));
    // The helper consults the predicate before the wait and again after it, so
    // the third call is the one that narrows the policy shut.
    const isRetryable = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await expect(
      retry({ fn, delay: 1, retries: 3, isRetryable }),
    ).rejects.toThrow("overloaded");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not let a caller predicate widen past a terminal status", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(401, "nope"));
    const isRetryable = vi.fn(() => true);

    await expect(
      retry({ fn, delay: 1, retries: 3, isRetryable }),
    ).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRetryable).not.toHaveBeenCalled();
  });

  it("waits for the hint an SDK error carried, not the caller's backoff", async () => {
    // The shape the two SDK transcription call sites normalise with
    // `toHttpError` before handing the failure to this helper.
    vi.useFakeTimers();
    try {
      const sdkError = Object.assign(new Error("429 Too Many Requests"), {
        status: 429,
        headers: { "retry-after": "1" },
      });
      const fn = vi
        .fn()
        .mockRejectedValueOnce(sdkError)
        .mockResolvedValueOnce("ok");
      const promise = retry({
        fn: async () => {
          try {
            return await fn();
          } catch (error) {
            throw toHttpError(error);
          }
        },
        delay: 1,
      });
      const settled = expect(promise).resolves.toBe("ok");

      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retry abort handling", () => {
  it("stops waiting for a Retry-After hint once the caller's signal fires", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fn = vi
        .fn()
        .mockRejectedValue(
          new HttpError(429, "Too Many Requests", { retryAfter: "30" }),
        );
      const promise = retry({ fn, delay: 1, signal: controller.signal });
      const rejected = expect(promise).rejects.toThrow("caller gave up");

      await vi.advanceTimersByTimeAsync(5_000);
      controller.abort(new Error("caller gave up"));
      await rejected;
      // The wait was for 30s. The abort has to end it, and no second attempt
      // may run.
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    const fn = vi.fn().mockRejectedValue(new HttpError(503, "overloaded"));

    await expect(
      retry({ fn, delay: 1, retries: 3, signal: controller.signal }),
    ).rejects.toThrow("already gone");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("leaves a wait that no signal watches untouched", async () => {
    vi.useFakeTimers();
    try {
      const promise = delayed(40);
      const settled = promise.then(() => "resolved");
      await vi.advanceTimersByTimeAsync(39);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(settled).resolves.toBe("resolved");
    } finally {
      vi.useRealTimers();
    }
  });
});

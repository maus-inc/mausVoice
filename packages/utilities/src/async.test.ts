import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_RETRY_DELAY_MS,
  batchAsync,
  delayed,
  retry,
} from "./async";
import { HttpError, MAX_RETRY_AFTER_MS, toHttpError } from "./http-error";

describe("batchAsync", () => {
  it("returns every result in the order the thunks were given", async () => {
    const thunks = [30, 10, 20, 5].map(
      (ms, index) => () =>
        new Promise<number>((resolve) => setTimeout(() => resolve(index), ms)),
    );

    await expect(batchAsync(2, thunks)).resolves.toEqual([0, 1, 2, 3]);
  });

  it("never runs more than the batch size at once", async () => {
    const inFlight: number[] = [];
    const peak: number[] = [];
    const thunks = Array.from({ length: 7 }, (_unused, index) => () => {
      inFlight.push(index);
      peak.push(inFlight.length);
      return Promise.resolve().then(() => {
        inFlight.pop();
        return index;
      });
    });

    await expect(batchAsync(3, thunks)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Math.max(...peak)).toBe(3);
  });

  it("stops handing out work once a chunk rejects", async () => {
    const started = vi.fn(() => Promise.resolve("ok"));
    const failing = vi.fn(() => Promise.reject(new Error("no")));

    await expect(batchAsync(2, [started, failing, started])).rejects.toThrow(
      "no",
    );
    // The first chunk was two thunks and it failed, so the third never ran.
    expect(started).toHaveBeenCalledTimes(1);
  });
});

describe("retry", () => {
  it("returns the first successful result", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retry({ fn, retries: 3, delay: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("refuses to run when the caller allows no attempts", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retry({ fn, retries: 0, delay: 1 })).rejects.toThrow(
      "Retry limit exceeded",
    );
    expect(fn).not.toHaveBeenCalled();
  });

  // `retries` is typed as a number, but callers pass it from JSON and config,
  // where a missing or malformed value becomes NaN. `NaN < 1` is false, so a
  // guard written as a plain comparison lets NaN retry until something else
  // stops the process rather than failing on the call.
  it("refuses to run when the retry count is not a finite number", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    await expect(retry({ fn, retries: Number.NaN, delay: 1 })).rejects.toThrow(
      "Retry limit exceeded",
    );
    await expect(
      retry({ fn, retries: Number.POSITIVE_INFINITY, delay: 1 }),
    ).rejects.toThrow("Retry limit exceeded");
    expect(fn).not.toHaveBeenCalled();
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

  it("never waits longer than the Retry-After cap when a caller asks for the whole hint", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          new HttpError(503, "Service Unavailable", { retryAfter: "3600" }),
        )
        .mockResolvedValueOnce("ok");
      const promise = retry({
        fn,
        delay: 1,
        maxRetryDelayMs: MAX_RETRY_AFTER_MS,
      });
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

  it("pins the interactive ceiling the helper defaults to", () => {
    // Two seconds, which outlives the window a 429 usually asks for and caps
    // the extra wait for three attempts at four seconds.
    expect(DEFAULT_MAX_RETRY_DELAY_MS).toBe(2_000);
  });

  it("holds an honest but long hint to the interactive ceiling by default", async () => {
    // A dictation is a person waiting to speak, not a background job. A
    // `Retry-After: 60` must not park the attempt for a minute, so the wait
    // stops at the default ceiling (pinned above) and the caller is told the
    // failure within seconds.
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          new HttpError(429, "Too Many Requests", { retryAfter: "60" }),
        )
        .mockResolvedValueOnce("ok");
      const promise = retry({ fn, delay: 1 });
      const settled = expect(promise).resolves.toBe("ok");

      await vi.advanceTimersByTimeAsync(1_999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shortens the caller's own delay to fit the ceiling", async () => {
    // The ceiling bounds what a server can add on top of the caller's pacing,
    // so a caller that asked for a longer wait than the default still gets it.
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new HttpError(503, "Service Unavailable"))
        .mockResolvedValueOnce("ok");
      const promise = retry({ fn, delay: 5_000, maxRetryDelayMs: 100 });
      const settled = expect(promise).resolves.toBe("ok");

      await vi.advanceTimersByTimeAsync(4_999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the caller's delay as the floor when the hint says zero", async () => {
    // `Retry-After: 0` is a real hint rather than a missing one, and the shared
    // helper still treats the caller's delay as the pace: a 0 second hint must
    // not turn a rate limit into a busy retry. The floor holds even when the
    // caller also drops the ceiling to zero.
    vi.useFakeTimers();
    try {
      for (const maxRetryDelayMs of [DEFAULT_MAX_RETRY_DELAY_MS, 0]) {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(
            new HttpError(429, "Too Many Requests", { retryAfter: "0" }),
          )
          .mockResolvedValueOnce("ok");
        const promise = retry({ fn, delay: 1, maxRetryDelayMs });
        const settled = expect(promise).resolves.toBe("ok");

        await vi.advanceTimersByTimeAsync(0);
        expect(fn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await settled;
        expect(fn).toHaveBeenCalledTimes(2);
      }
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
      // This caller honours the hint in full, so the wait really is 30s and the
      // abort at 5s is what has to end it.
      const promise = retry({
        fn,
        delay: 1,
        maxRetryDelayMs: MAX_RETRY_AFTER_MS,
        signal: controller.signal,
      });
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

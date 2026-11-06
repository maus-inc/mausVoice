import { describe, expect, it, vi } from "vitest";
import { NativeRecordingLease } from "./native-recording-lease";
import { BrowserRecordingLease } from "./browser-recording-lease";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("native recording lease", () => {
  it("does not treat a failed audio handoff as confirmed hardware release", async () => {
    const discard = deferred<void>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(17);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return Promise.resolve({
          samples: [0.5],
          sampleRate: 16000,
          captureFailed: true,
        });
      if (command === "discard_recording") return discard.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "failed-handoff");
    await lease.start(null);
    expect((await lease.stop()).captureFailed).toBe(true);
    const cancellation = lease.cancel();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "failed-handoff",
      generation: 17,
    });
    let settled = false;
    void cancellation.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    discard.resolve();
    await cancellation;
    expect(settled).toBe(true);
  });

  it("coalesces a start reentered synchronously by the admission transport", async () => {
    let nested: Promise<{ sampleRate: number }> | undefined;
    let reentered = false;
    let lease!: NativeRecordingLease;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") {
        if (!reentered) {
          reentered = true;
          nested = lease.start("Mic");
        }
        return Promise.resolve(7);
      }
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      return Promise.resolve(undefined);
    });
    lease = new NativeRecordingLease(invoke, "reentrant-admission");
    const opening = lease.start("Mic");
    expect(nested).toBe(opening);
    await opening;
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "recording_generation",
      ),
    ).toHaveLength(1);
    await lease.cancel();
  });

  it("releases local activity if admission dispatch synchronously cancels and never replies", async () => {
    let admissions = 0;
    let lease!: NativeRecordingLease;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") {
        if (++admissions === 1) {
          void lease.cancel();
          return new Promise<never>(() => undefined);
        }
        return Promise.resolve(8);
      }
      return Promise.resolve(undefined);
    });
    lease = new NativeRecordingLease(invoke, "cancel-at-admission");
    void lease.start(null).catch(() => undefined);
    const browser = new BrowserRecordingLease(invoke);
    await expect(browser.acquire()).resolves.toBeUndefined();
    await browser.release();
  });

  it.each([
    null,
    {},
    { sampleRate: 0 },
    { sampleRate: -1 },
    { sampleRate: 1.5 },
    { sampleRate: Number.NaN },
    { sampleRate: 0x80000000 },
    { sampleRate: "16000" },
  ])(
    "rejects a malformed start response and releases its possible capture: %o",
    async (result) => {
      const invoke = vi.fn((command: string) => {
        if (command === "recording_generation") return Promise.resolve(9);
        if (command === "start_recording") return Promise.resolve(result);
        return Promise.resolve(undefined);
      });
      const lease = new NativeRecordingLease(invoke, "invalid-start");
      await expect(lease.start(null)).rejects.toThrow(
        "Invalid recording start response",
      );
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("discard_recording", {
          ownerId: "invalid-start",
          generation: 9,
        }),
      );
    },
  );

  it("does not discard an owned stop when the start response is malformed", async () => {
    const opening = deferred<unknown>();
    const stopped = deferred<unknown>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(10);
      if (command === "start_recording") return opening.promise;
      if (command === "stop_recording") return stopped.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "invalid-start-during-stop");
    const started = lease.start(null);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_recording", expect.anything()),
    );
    const stopping = lease.stop();
    opening.resolve({ sampleRate: 0 });
    await expect(started).rejects.toThrow("Invalid recording start response");
    expect(
      invoke.mock.calls.some(([command]) => command === "discard_recording"),
    ).toBe(false);
    stopped.resolve({ samples: [0.25], sampleRate: 16000 });
    expect(Array.from((await stopping).samples)).toEqual([0.25]);
  });

  it("coalesces a stop reentered synchronously by the stop transport", async () => {
    let nested: Promise<unknown> | undefined;
    let reentered = false;
    let lease!: NativeRecordingLease;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(7);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        if (!reentered) {
          reentered = true;
          nested = lease.stop();
        }
        return Promise.resolve({ samples: [0.5], sampleRate: 16000 });
      }
      return Promise.resolve(undefined);
    });
    lease = new NativeRecordingLease(invoke, "reentrant-stop-transport");
    await lease.start("Mic");
    const stopping = lease.stop();
    expect(nested).toBe(stopping);
    expect(Array.from((await stopping).samples)).toEqual([0.5]);
    expect(
      invoke.mock.calls.filter(([command]) => command === "stop_recording"),
    ).toHaveLength(1);
  });

  it("retries a lost stop response and acknowledges the recovered audio", async () => {
    let stops = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(12);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        if (++stops === 1) return Promise.reject(new Error("reply lost"));
        return Promise.resolve({ samples: [0.5, 0.25], sampleRate: 16000 });
      }
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "lost-stop");
    await lease.start(null);
    expect(Array.from((await lease.stop()).samples)).toEqual([0.5, 0.25]);
    expect(
      invoke.mock.calls.filter(([command]) => command === "stop_recording"),
    ).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith("acknowledge_recording", {
      ownerId: "lost-stop",
      generation: 12,
    });
    expect(
      invoke.mock.calls.some(([command]) => command === "discard_recording"),
    ).toBe(false);
  });

  it("does not acknowledge a malformed response before a successful retry", async () => {
    let stops = 0;
    const retry = deferred<unknown>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(21);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return ++stops === 1
          ? Promise.resolve(new ArrayBuffer(2))
          : retry.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "invalid-stop-reply");
    await lease.start(null);
    const stopping = lease.stop();
    await Promise.resolve();
    expect(stops).toBe(2);
    expect(
      invoke.mock.calls.some(([name]) => name === "acknowledge_recording"),
    ).toBe(false);
    retry.resolve({ samples: [0.5], sampleRate: 16000 });
    expect(Array.from((await stopping).samples)).toEqual([0.5]);
    expect(invoke).toHaveBeenCalledWith("acknowledge_recording", {
      ownerId: "invalid-stop-reply",
      generation: 21,
    });
  });

  it("retries acknowledgement on later cancellation without waiting for IPC", async () => {
    const acknowledgement = deferred<unknown>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(20);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return Promise.resolve({ samples: [0.5], sampleRate: 16000 });
      if (command === "acknowledge_recording") return acknowledgement.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "lost-ack");
    await lease.start(null);
    expect(Array.from((await lease.stop()).samples)).toEqual([0.5]);
    await lease.cancel();
    expect(
      invoke.mock.calls.filter(([name]) => name === "acknowledge_recording"),
    ).toHaveLength(2);
    expect(
      invoke.mock.calls.some(([name]) => name === "discard_recording"),
    ).toBe(false);
    acknowledgement.resolve(undefined);
  });

  it("recovers a silent lost reply without discarding the in-flight stop", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<unknown>();
      const invoke = vi.fn((command: string) => {
        if (command === "recording_generation") return Promise.resolve(13);
        if (command === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (command === "stop_recording") {
          const count = invoke.mock.calls.filter(
            ([name]) => name === "stop_recording",
          ).length;
          return count === 1
            ? first.promise
            : Promise.resolve({ samples: [0.75], sampleRate: 16000 });
        }
        return Promise.resolve(undefined);
      });
      const lease = new NativeRecordingLease(invoke, "silent-stop");
      await lease.start(null);
      const stopping = lease.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(Array.from((await stopping).samples)).toEqual([0.75]);
      first.resolve({ samples: [0.2], sampleRate: 16000 });
      await Promise.resolve();
      expect(
        invoke.mock.calls.filter(([name]) => name === "acknowledge_recording"),
      ).toHaveLength(1);
      expect(
        invoke.mock.calls.some(([name]) => name === "discard_recording"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an earlier stop when a concurrent retry fails", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<unknown>();
      let stops = 0;
      const invoke = vi.fn((command: string) => {
        if (command === "recording_generation") return Promise.resolve(14);
        if (command === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (command === "stop_recording")
          return ++stops === 1
            ? first.promise
            : Promise.reject(new Error("retry failed"));
        return Promise.resolve(undefined);
      });
      const lease = new NativeRecordingLease(invoke, "overlapping-stop");
      await lease.start(null);
      const stopping = lease.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        invoke.mock.calls.some(([name]) => name === "discard_recording"),
      ).toBe(false);
      first.resolve({ samples: [0.5], sampleRate: 16000 });
      expect(Array.from((await stopping).samples)).toEqual([0.5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a hanging stop without starting a retry or acknowledging late audio", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<unknown>();
      const invoke = vi.fn((command: string) => {
        if (command === "recording_generation") return Promise.resolve(15);
        if (command === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (command === "stop_recording") return first.promise;
        return Promise.resolve(undefined);
      });
      const lease = new NativeRecordingLease(invoke, "cancel-hanging-stop");
      await lease.start(null);
      const stopping = lease.stop();
      const rejection = expect(stopping).rejects.toThrow("cancelled");
      await lease.cancel();
      await rejection;
      await vi.advanceTimersByTimeAsync(10000);
      first.resolve({ samples: [0.5], sampleRate: 16000 });
      await Promise.resolve();
      expect(
        invoke.mock.calls.filter(([name]) => name === "stop_recording"),
      ).toHaveLength(1);
      expect(
        invoke.mock.calls.some(([name]) => name === "acknowledge_recording"),
      ).toBe(false);
      expect(invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "cancel-hanging-stop",
        generation: 15,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish a stop reply cancelled between transport and delivery", async () => {
    const reply = deferred<unknown>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(16);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") return reply.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "cancel-before-delivery");
    await lease.start(null);
    const stopping = lease.stop();
    const rejected = expect(stopping).rejects.toThrow("cancelled");
    reply.resolve({ samples: [0.5], sampleRate: 16000 });
    await Promise.resolve();
    await lease.cancel();
    await rejected;
    expect(
      invoke.mock.calls.some(([name]) => name === "acknowledge_recording"),
    ).toBe(false);
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "cancel-before-delivery",
      generation: 16,
    });
  });

  it("does not retry a failed stop after the user cancels", async () => {
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(7);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return Promise.reject(new Error("reply lost"));
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "cancel-after-failure");
    await lease.start(null);
    await expect(lease.stop()).rejects.toThrow("reply lost");
    await lease.cancel();
    const attemptsAtCancellation = invoke.mock.calls.filter(
      ([command]) => command === "stop_recording",
    ).length;
    await expect(lease.stop()).resolves.toEqual({
      samples: new Float32Array(),
      sampleRate: 0,
    });
    await Promise.resolve();
    expect(
      invoke.mock.calls.filter(([command]) => command === "stop_recording"),
    ).toHaveLength(attemptsAtCancellation);
  });

  it("does not turn an explicit cancellation into a normal stop", async () => {
    const discard = deferred<void>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(7);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "discard_recording") return discard.promise;
      if (command === "stop_recording")
        return Promise.resolve({ samples: [0.5], sampleRate: 16000 });
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "cancel-before-stop");
    await lease.start(null);
    const cancelling = lease.cancel();
    await expect(lease.stop()).resolves.toEqual({
      samples: new Float32Array(),
      sampleRate: 0,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "stop_recording",
      expect.anything(),
    );
    const successor = new NativeRecordingLease(invoke, "next");
    const opening = successor.start(null);
    await Promise.resolve();
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "recording_generation",
      ),
    ).toHaveLength(1);
    discard.resolve();
    await cancelling;
    await opening;
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "cancel-before-stop",
      generation: 7,
    });
    await successor.cancel();
  });

  it("stops its own pending native start without waiting for the start reply", async () => {
    const start = deferred<{ sampleRate: number }>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(7);
      return command === "start_recording"
        ? start.promise
        : Promise.resolve({ samples: [0.5], sampleRate: 16000 });
    });
    const lease = new NativeRecordingLease(invoke, "attempt-a");
    const opening = lease.start("Mic");
    await Promise.resolve();
    const firstStop = lease.stop();
    const secondStop = lease.stop();
    expect(firstStop).toBe(secondStop);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(Array.from((await firstStop).samples)).toEqual([0.5]);
    start.resolve({ sampleRate: 16000 });
    await opening;
    expect(invoke).toHaveBeenNthCalledWith(2, "start_recording", {
      ownerId: "attempt-a",
      generation: 7,
      args: { preferredMicrophone: "Mic" },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "stop_recording", {
      ownerId: "attempt-a",
      generation: 7,
    });
  });

  it("does not discard when the start reply fails while an owned stop is in flight", async () => {
    const openingReply = deferred<{ sampleRate: number }>();
    const stopReply = deferred<{ samples: number[]; sampleRate: number }>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(7);
      if (command === "start_recording") return openingReply.promise;
      if (command === "stop_recording") return stopReply.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "opening");
    const opening = lease.start(null);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_recording", expect.anything()),
    );
    const stopping = lease.stop();
    openingReply.reject(new Error("start reply lost"));
    await expect(opening).rejects.toThrow("start reply lost");
    expect(
      invoke.mock.calls.some(([command]) => command === "discard_recording"),
    ).toBe(false);
    stopReply.resolve({ samples: [0.5], sampleRate: 16000 });
    expect(Array.from((await stopping).samples)).toEqual([0.5]);
  });

  it("does not dispatch a start when stopped while admission is pending", async () => {
    const generation = deferred<number>();
    const invoke = vi.fn(() => generation.promise);
    const lease = new NativeRecordingLease(invoke, "attempt-admission");
    const opening = lease.start(null);
    const stopping = lease.stop();
    generation.resolve(4);
    await expect(opening).rejects.toThrow("closed");
    await expect(stopping).resolves.toEqual({
      samples: new Float32Array(),
      sampleRate: 0,
    });
    expect(invoke.mock.calls).toEqual([
      ["recording_generation", { ownerId: "attempt-admission" }],
      ["discard_recording", { ownerId: "attempt-admission", generation: 4 }],
    ]);
  });

  it("does not wait for a lost reservation reply when stopped before capture", async () => {
    const reservation = deferred<number>();
    const invoke = vi.fn((_command: string) => reservation.promise);
    const lease = new NativeRecordingLease(invoke, "lost-reservation");
    void lease.start(null).catch(() => undefined);
    await expect(lease.stop()).resolves.toEqual({
      samples: new Float32Array(),
      sampleRate: 0,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("uses only the late admission token when cancelled before reservation replies", async () => {
    const generation = deferred<number>();
    const invoke = vi.fn((command: string) =>
      command === "recording_generation"
        ? generation.promise
        : Promise.resolve(undefined),
    );
    const lease = new NativeRecordingLease(invoke, "reused");
    const opening = lease.start(null);
    const rejected = expect(opening).rejects.toThrow("closed");
    await lease.cancel();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "recording_generation",
    ]);
    generation.resolve(42);
    await rejected;
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "reused",
        generation: 42,
      }),
    );
    expect(
      invoke.mock.calls.some(([command]) => command === "start_recording"),
    ).toBe(false);
  });

  it("does not block a successor on cleanup of an admission that never started", async () => {
    const reservation = deferred<number>();
    const discarded = deferred<void>();
    const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === "recording_generation") {
        return args?.ownerId === "old"
          ? reservation.promise
          : Promise.resolve(2);
      }
      if (command === "discard_recording" && args?.ownerId === "old")
        return discarded.promise;
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      return Promise.resolve(undefined);
    });
    const old = new NativeRecordingLease(invoke, "old");
    const opening = old.start(null);
    await old.cancel();
    reservation.resolve(1);
    await expect(opening).rejects.toThrow("closed");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "old",
        generation: 1,
      }),
    );
    const next = new NativeRecordingLease(invoke, "next");
    await expect(next.start(null)).resolves.toEqual({ sampleRate: 16000 });
    expect(invoke).toHaveBeenCalledWith("start_recording", {
      ownerId: "next",
      generation: 2,
      args: { preferredMicrophone: null },
    });
    await next.cancel();
    discarded.resolve();
  });

  it("releases an unused admission if the dispatch guard throws", async () => {
    const invoke = vi.fn((command: string) =>
      command === "recording_generation"
        ? Promise.resolve(1)
        : command === "start_recording"
          ? Promise.resolve({ sampleRate: 16000 })
          : Promise.resolve(undefined),
    );
    const lease = new NativeRecordingLease(invoke, "guard");
    await expect(
      lease.start(null, false, undefined, () => {
        throw new Error("guard failed");
      }),
    ).rejects.toThrow("guard failed");
    expect(
      invoke.mock.calls.some(([command]) => command === "start_recording"),
    ).toBe(false);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "guard",
        generation: 1,
      }),
    );
    const successor = new NativeRecordingLease(invoke, "successor");
    await successor.start(null);
    await successor.cancel();
  });

  it("does not dispatch start if the dispatch guard synchronously stops the lease", async () => {
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(1);
      if (command === "stop_recording")
        return Promise.resolve({ samples: [], sampleRate: 0 });
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "reentrant-stop");
    let stopping: Promise<unknown> | undefined;
    const start = lease.start(null, false, undefined, () => {
      stopping = lease.stop();
      return true;
    });
    await expect(start).rejects.toThrow("closed");
    await expect(stopping).resolves.toEqual({
      samples: new Float32Array(),
      sampleRate: 0,
    });
    expect(
      invoke.mock.calls.some(([command]) => command === "start_recording"),
    ).toBe(false);
  });

  it("observes a late start rejection when dispatch notification throws", async () => {
    const opening = deferred<{ sampleRate: number }>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(1);
      if (command === "start_recording") return opening.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "notification-error");
    await expect(
      lease.start(null, false, () => {
        throw new Error("notification failed");
      }),
    ).rejects.toThrow("notification failed");
    opening.reject(new Error("late native reply"));
    await Promise.resolve();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "notification-error",
        generation: 1,
      }),
    );
  });

  it("does not guess a token after a lost reservation reply", async () => {
    const invoke = vi.fn((_command: string) =>
      Promise.reject(new Error("reply lost")),
    );
    const lease = new NativeRecordingLease(invoke, "reused");
    await expect(lease.start(null)).rejects.toThrow("reply lost");
    await lease.cancel();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "recording_generation",
    ]);
  });

  it("scopes a concurrent stop when a competing owner rejects startup", async () => {
    const invoke = vi.fn((command: string) =>
      command === "recording_generation"
        ? Promise.resolve(0)
        : Promise.reject(new Error("busy")),
    );
    const lease = new NativeRecordingLease(invoke, "attempt-b");
    const opening = lease.start(null);
    await Promise.resolve();
    const stopping = lease.stop();
    await expect(opening).rejects.toThrow("busy");
    await expect(stopping).rejects.toThrow("busy");
    expect(invoke.mock.calls.map(([command]) => command).slice(0, 4)).toEqual([
      "recording_generation",
      "start_recording",
      "stop_recording",
      "stop_recording",
    ]);
    expect(
      invoke.mock.calls.some(([command]) => command === "discard_recording"),
    ).toBe(false);
    expect(invoke).toHaveBeenCalledWith("stop_recording", {
      ownerId: "attempt-b",
      generation: 0,
    });
  });

  it("does not allow a pause queued behind a stop to reach native", async () => {
    const start = deferred<{ sampleRate: number }>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(0);
      if (command === "start_recording") return start.promise;
      if (command === "stop_recording")
        return Promise.resolve({ samples: [], sampleRate: 0 });
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "attempt-c");
    const opening = lease.start(null);
    await Promise.resolve();
    const pausing = lease.pause();
    const stopping = lease.stop();
    start.resolve({ sampleRate: 16000 });
    await opening;
    await expect(pausing).rejects.toThrow("closed");
    await stopping;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "recording_generation",
      "start_recording",
      "stop_recording",
      "acknowledge_recording",
    ]);
  });

  it("allows an owner-checked stop to be retried after a failure", async () => {
    let stops = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(0);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        if (++stops <= 2) return Promise.reject(new Error("stop failed"));
        return Promise.resolve({ samples: [0.5], sampleRate: 16000 });
      }
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "attempt-retry");
    await lease.start(null);
    await expect(lease.stop()).rejects.toThrow("stop failed");
    await expect(lease.pause()).rejects.toThrow("closed");
    expect(Array.from((await lease.stop()).samples)).toEqual([0.5]);
    expect(invoke).toHaveBeenLastCalledWith("acknowledge_recording", {
      ownerId: "attempt-retry",
      generation: expect.any(Number),
    });
  });

  it("cancels a dispatched start without waiting for its response", async () => {
    const opening = deferred<{ sampleRate: number }>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(0);
      if (command === "start_recording") return opening.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "pending-open");
    const started = lease.start(null);
    await Promise.resolve();
    await lease.cancel();
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "pending-open",
      generation: expect.any(Number),
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "stop_recording",
      expect.anything(),
    );
    opening.resolve({ sampleRate: 16000 });
    await started;
    await lease.cancel();
    expect(
      invoke.mock.calls.filter(([command]) => command === "discard_recording"),
    ).toHaveLength(1);
  });

  it("cleans a failed start whose response may have been lost", async () => {
    let owner: string | undefined;
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "recording_generation") return 0;
        if (command === "start_recording") {
          owner = args?.ownerId as string;
          throw new Error("response lost");
        }
        if (command === "discard_recording" && args?.ownerId === owner)
          owner = undefined;
      },
    );
    const lease = new NativeRecordingLease(invoke, "lost-start");
    await expect(lease.start(null)).rejects.toThrow("response lost");
    await vi.waitFor(() => expect(owner).toBeUndefined());
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "lost-start",
      generation: expect.any(Number),
    });
  });

  it("preserves a failed stop while recovering before admitting a successor", async () => {
    let owner: string | undefined;
    let stops = 0;
    const retry = deferred<{ samples: number[]; sampleRate: number }>();
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "recording_generation") return 0;
        if (command === "start_recording") {
          if (owner) throw new Error("busy");
          owner = args?.ownerId as string;
          return { sampleRate: 16000 };
        }
        if (command === "stop_recording") {
          if (++stops <= 4) throw new Error("stop transport failed");
          const response = await retry.promise;
          if (owner === args?.ownerId) owner = undefined;
          return response;
        }
        if (command === "discard_recording")
          throw new Error("must not discard the recovery");
      },
    );
    const old = new NativeRecordingLease(invoke, "old");
    await old.start(null);
    await expect(old.stop()).rejects.toThrow("stop transport failed");
    await vi.waitFor(() => expect(stops).toBe(4));
    // Allow the failed background attempt to clear its in-flight slot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const successor = new NativeRecordingLease(invoke, "new");
    const opening = successor.start(null);
    await vi.waitFor(() => expect(stops).toBe(5));
    expect(owner).toBe("old");
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(1);
    retry.resolve({ samples: [0.5], sampleRate: 16000 });
    await opening;
    expect(owner).toBe("new");
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "acknowledge_recording",
      ),
    ).toBe(false);
    expect(Array.from((await old.stop()).samples)).toEqual([0.5]);
    expect(invoke).toHaveBeenCalledWith("acknowledge_recording", {
      ownerId: "old",
      generation: 0,
    });
    expect(
      invoke.mock.calls.some(([command]) => command === "discard_recording"),
    ).toBe(false);
  });

  it("does not accept an empty unowned reply after a confirmed recording", async () => {
    let stops = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(10);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        return Promise.resolve(
          ++stops === 1
            ? { samples: [], sampleRate: 0 }
            : { samples: [0.5], sampleRate: 16000 },
        );
      }
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "empty-after-start");
    await lease.start(null);
    expect(Array.from((await lease.stop()).samples)).toEqual([0.5]);
    expect(stops).toBe(2);
  });

  it("keeps automatically recovered audio until the caller receives it", async () => {
    let stops = 0;
    let lease!: NativeRecordingLease;
    let nested: Promise<unknown> | undefined;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(11);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        if (++stops <= 2) return Promise.reject(new Error("lost response"));
        return Promise.resolve({ samples: [0.25, 0.5], sampleRate: 16000 });
      }
      if (command === "acknowledge_recording") nested = lease.stop();
      return Promise.resolve(undefined);
    });
    lease = new NativeRecordingLease(invoke, "automatic-recovery");
    await lease.start(null);
    await expect(lease.stop()).rejects.toThrow("lost response");
    await vi.waitFor(() => expect(stops).toBe(3));
    expect(
      invoke.mock.calls.some(
        ([command]) =>
          command === "discard_recording" ||
          command === "acknowledge_recording",
      ),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delivery = lease.stop();
    expect(nested).toBe(delivery);
    expect(Array.from((await delivery).samples)).toEqual([0.25, 0.5]);
    expect(invoke).toHaveBeenCalledWith("acknowledge_recording", {
      ownerId: "automatic-recovery",
      generation: 11,
    });
  });

  it("delivers a recovered stop to a waiting current owner", async () => {
    const recovery = deferred<unknown>();
    let stops = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(22);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return ++stops <= 2
          ? Promise.reject(new Error("lost"))
          : recovery.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "waiting-owner");
    await lease.start(null);
    await expect(lease.stop()).rejects.toThrow("lost");
    const waiting = lease.waitForStopRecovery(5000, () => true);
    recovery.resolve({ samples: [0.5], sampleRate: 16000 });
    expect(Array.from((await waiting)!.samples)).toEqual([0.5]);
    expect(invoke).toHaveBeenCalledWith("acknowledge_recording", {
      ownerId: "waiting-owner",
      generation: 22,
    });
  });

  it("retries a failed recovery for the same owner without discarding audio", async () => {
    let stops = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(24);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        return ++stops <= 4
          ? Promise.reject(new Error("lost"))
          : Promise.resolve({ samples: [0.25], sampleRate: 16000 });
      }
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "retry-recovery");
    await lease.start(null);
    await expect(lease.stop()).rejects.toThrow("lost");
    await vi.waitFor(() => expect(stops).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recovered = await lease.waitForStopRecovery(5_000, () => true);
    expect(Array.from(recovered!.samples)).toEqual([0.25]);
    expect(stops).toBe(5);
    expect(invoke).toHaveBeenCalledWith("stop_recording", {
      ownerId: "retry-recovery",
      generation: 24,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_recording",
      expect.anything(),
    );
  });

  it("does not consume or acknowledge recovery after a timeout or retirement", async () => {
    for (const retired of [false, true]) {
      vi.useFakeTimers();
      try {
        const recovery = deferred<unknown>();
        let stops = 0;
        let current = true;
        const invoke = vi.fn((command: string) => {
          if (command === "recording_generation") return Promise.resolve(23);
          if (command === "start_recording")
            return Promise.resolve({ sampleRate: 16000 });
          if (command === "stop_recording")
            return ++stops <= 2
              ? Promise.reject(new Error("lost"))
              : recovery.promise;
          return Promise.resolve(undefined);
        });
        const lease = new NativeRecordingLease(
          invoke,
          `stale-recovery-${retired}`,
        );
        await lease.start(null);
        await expect(lease.stop()).rejects.toThrow("lost");
        const waiting = lease.waitForStopRecovery(50, () => current);
        if (retired) current = false;
        else await vi.advanceTimersByTimeAsync(50);
        recovery.resolve({ samples: [0.5], sampleRate: 16000 });
        expect(await waiting).toBeNull();
        await Promise.resolve();
        expect(
          invoke.mock.calls.some(
            ([command]) => command === "acknowledge_recording",
          ),
        ).toBe(false);
        await lease.cancel();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("coalesces a stop reentered synchronously by the recovery transport", async () => {
    const recovery = deferred<unknown>();
    let stops = 0;
    let nested: Promise<unknown> | undefined;
    let lease!: NativeRecordingLease;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(20);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        if (++stops <= 2) return Promise.reject(new Error("lost"));
        if (stops === 3) nested = lease.stop();
        return recovery.promise;
      }
      return Promise.resolve(undefined);
    });
    lease = new NativeRecordingLease(invoke, "reentrant-recovery");
    await lease.start(null);
    await expect(lease.stop()).rejects.toThrow("lost");
    expect(stops).toBe(3);
    expect(nested).toBeDefined();
    recovery.resolve({ samples: [0.25], sampleRate: 16000 });
    await expect(nested).resolves.toMatchObject({ sampleRate: 16000 });
    expect(stops).toBe(3);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "acknowledge_recording",
      ),
    ).toHaveLength(1);
  });

  it("expires a recovered copy without acknowledging audio no caller received", async () => {
    vi.useFakeTimers();
    try {
      let stops = 0;
      const invoke = vi.fn((command: string) => {
        if (command === "recording_generation") return Promise.resolve(13);
        if (command === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (command === "stop_recording") {
          if (++stops <= 2) return Promise.reject(new Error("lost"));
          return Promise.resolve({ samples: [0.5], sampleRate: 16000 });
        }
        return Promise.resolve(undefined);
      });
      const lease = new NativeRecordingLease(invoke, "expiring-recovery");
      await lease.start(null);
      await expect(lease.stop()).rejects.toThrow("lost");
      await vi.waitFor(() => expect(stops).toBe(3));
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(lease.stop()).rejects.toThrow("expired");
      expect(
        invoke.mock.calls.some(
          ([command]) => command === "acknowledge_recording",
        ),
      ).toBe(false);
      await lease.cancel();
      await expect(lease.stop()).resolves.toEqual({
        samples: new Float32Array(),
        sampleRate: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports whether a failed stop can still deliver its audio", async () => {
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(15);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return Promise.reject(new Error("lost"));
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "recoverable-owner");
    // Nothing has failed yet: there is nothing to wait for.
    expect(lease.canRecoverStop).toBe(false);
    await lease.start(null);
    expect(lease.canRecoverStop).toBe(false);
    await expect(lease.stop()).rejects.toThrow("lost");
    // The reply was lost, but the sealed audio may still be recoverable.
    expect(lease.canRecoverStop).toBe(true);
    await lease.cancel();
    expect(lease.canRecoverStop).toBe(false);
  });

  it("stops reporting recoverable audio once the retained copy expires", async () => {
    vi.useFakeTimers();
    try {
      let stops = 0;
      const invoke = vi.fn((command: string) => {
        if (command === "recording_generation") return Promise.resolve(16);
        if (command === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (command === "stop_recording")
          return ++stops <= 2
            ? Promise.reject(new Error("lost"))
            : Promise.resolve({ samples: [0.5], sampleRate: 16000 });
        return Promise.resolve(undefined);
      });
      const lease = new NativeRecordingLease(invoke, "expired-owner");
      await lease.start(null);
      await expect(lease.stop()).rejects.toThrow("lost");
      expect(lease.canRecoverStop).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      // The retry retained a copy, so it is deliverable before expiry.
      expect(stops).toBe(3);
      expect(lease.canRecoverStop).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.canRecoverStop).toBe(false);
      await expect(lease.stop()).rejects.toThrow("expired");
      await lease.cancel();
      expect(lease.canRecoverStop).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicit cancellation prevents a late recovery from being published", async () => {
    const recovery = deferred<unknown>();
    let stops = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(14);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return ++stops <= 2
          ? Promise.reject(new Error("lost"))
          : recovery.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "cancel-recovery");
    await lease.start(null);
    await expect(lease.stop()).rejects.toThrow("lost");
    const waiting = lease.waitForStopRecovery(5_000, () => true);
    await lease.cancel();
    expect(await waiting).toBeNull();
    recovery.resolve({ samples: [0.5], sampleRate: 16000 });
    await Promise.resolve();
    await expect(lease.stop()).resolves.toEqual({
      samples: new Float32Array(),
      sampleRate: 0,
    });
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "cancel-recovery",
      generation: 14,
    });
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "acknowledge_recording",
      ),
    ).toBe(false);
  });

  it("bounds undelivered recovery copies and resumes after space is released", async () => {
    const leases: NativeRecordingLease[] = [];
    let lastInvoke!: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    let discardedOld = false;
    try {
      for (let index = 0; index < 9; index++) {
        let stops = 0;
        const invoke = vi.fn(
          (command: string, args?: Record<string, unknown>) => {
            if (
              command === "discard_recording" &&
              args?.ownerId === "bounded-8"
            )
              discardedOld = true;
            if (command === "recording_generation")
              return Promise.resolve(index + 30);
            if (command === "start_recording")
              return Promise.resolve({ sampleRate: 16000 });
            if (command === "stop_recording") {
              if (++stops <= 2) return Promise.reject(new Error("lost"));
              return Promise.resolve({ samples: [0.5], sampleRate: 16000 });
            }
            return Promise.resolve(undefined);
          },
        );
        lastInvoke = invoke;
        const lease = new NativeRecordingLease(invoke, `bounded-${index}`);
        leases.push(lease);
        await lease.start(null);
        await expect(lease.stop()).rejects.toThrow("lost");
        await vi.waitFor(() => expect(stops).toBe(3));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const blocked = new NativeRecordingLease(lastInvoke, "blocked");
      await expect(blocked.start(null)).rejects.toThrow("buffer is full");
      await leases[0]!.cancel();
      const successor = new NativeRecordingLease(lastInvoke, "successor");
      await expect(successor.start(null)).resolves.toEqual({
        sampleRate: 16000,
      });
      await successor.cancel();
      expect(discardedOld).toBe(false);
    } finally {
      await Promise.all(leases.map((lease) => lease.cancel()));
    }
  });

  it("a late failed start reply cannot discard an in-flight stop recovery", async () => {
    const opening = deferred<{ sampleRate: number }>();
    const recovery = deferred<unknown>();
    let stops = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(12);
      if (command === "start_recording") return opening.promise;
      if (command === "stop_recording")
        return ++stops <= 2
          ? Promise.reject(new Error("stop reply lost"))
          : recovery.promise;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(invoke, "late-start-failure");
    const started = lease.start(null);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_recording", expect.anything()),
    );
    await expect(lease.stop()).rejects.toThrow("stop reply lost");
    opening.reject(new Error("start reply lost"));
    await expect(started).rejects.toThrow("start reply lost");
    expect(
      invoke.mock.calls.some(([command]) => command === "discard_recording"),
    ).toBe(false);
    recovery.resolve({ samples: [0.75], sampleRate: 16000 });
    expect(Array.from((await lease.stop()).samples)).toEqual([0.75]);
  });

  it("does not admit a start cancelled while an earlier recovery is pending", async () => {
    const recovery = deferred<{ samples: number[]; sampleRate: number }>();
    let stops = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === "recording_generation") return 0;
      if (command === "start_recording") return { sampleRate: 16000 };
      if (command === "stop_recording") {
        if (++stops <= 2) throw new Error("stop failed");
        return recovery.promise;
      }
    });
    const old = new NativeRecordingLease(invoke, "old-pending");
    await old.start(null);
    await expect(old.stop()).rejects.toThrow("stop failed");
    const successor = new NativeRecordingLease(invoke, "cancelled-successor");
    const opening = successor.start(null);
    const stopping = successor.stop();
    recovery.resolve({ samples: [0.25], sampleRate: 16000 });
    await expect(opening).rejects.toThrow("closed");
    await expect(stopping).resolves.toEqual({
      samples: new Float32Array(),
      sampleRate: 0,
    });
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(1);
    await old.cancel();
  });

  it("carries its ID through pause and resume", async () => {
    const invoke = vi.fn((command: string) =>
      Promise.resolve(
        command === "recording_generation" ? 0 : { sampleRate: 16000 },
      ),
    );
    const lease = new NativeRecordingLease(invoke, "attempt-d");
    await lease.start(null);
    await lease.pause();
    await lease.resume();
    expect(invoke).toHaveBeenCalledWith("pause_recording", {
      ownerId: "attempt-d",
      generation: expect.any(Number),
    });
    expect(invoke).toHaveBeenCalledWith("resume_recording", {
      ownerId: "attempt-d",
      generation: expect.any(Number),
    });
  });
});

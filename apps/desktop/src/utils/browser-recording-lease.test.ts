import { describe, expect, it, vi } from "vitest";
import { BrowserRecordingLease } from "./browser-recording-lease";
import {
  acquireLocalNativeRecording,
  releaseLocalNativeRecording,
} from "./local-recording-activity";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("browser recording lease", () => {
  it("keeps native capture blocked until browser release is acknowledged", async () => {
    const release = deferred<unknown>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(1);
      if (command === "release_browser_recording") return release.promise;
      return Promise.resolve();
    });
    const lease = new BrowserRecordingLease(invoke);
    await lease.acquire();
    const ending = lease.release();
    const native = {};
    expect(acquireLocalNativeRecording(invoke, native)).toBe(false);
    release.resolve(undefined);
    await ending;
    expect(acquireLocalNativeRecording(invoke, native)).toBe(true);
    releaseLocalNativeRecording(invoke, native);
  });

  it("cancels a delayed admission without starting browser capture", async () => {
    const generation = deferred<unknown>();
    const invoke = vi.fn((command: string) =>
      command === "recording_generation"
        ? generation.promise
        : Promise.resolve(),
    );
    const lease = new BrowserRecordingLease(invoke);
    const acquiring = lease.acquire();
    const rejected = expect(acquiring).rejects.toThrow("cancelled");
    await lease.release();
    const native = {};
    expect(acquireLocalNativeRecording(invoke, native)).toBe(true);
    releaseLocalNativeRecording(invoke, native);
    generation.resolve(2);
    await rejected;
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("release_browser_recording", {
        ownerId: expect.any(String),
        generation: 2,
      }),
    );
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.filter(
          ([command]) => command === "release_browser_recording",
        ).length,
      ).toBeGreaterThanOrEqual(1),
    );
    await vi.waitFor(() =>
      expect(acquireLocalNativeRecording(invoke, native)).toBe(true),
    );
    releaseLocalNativeRecording(invoke, native);
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "claim_browser_recording",
      ),
    ).toBe(false);
  });

  it("releases again when a pending claim settles after cancellation", async () => {
    const claim = deferred<unknown>();
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(1);
      if (command === "claim_browser_recording") return claim.promise;
      return Promise.resolve();
    });
    const lease = new BrowserRecordingLease(invoke);
    const acquiring = lease.acquire();
    const rejected = expect(acquiring).rejects.toThrow("cancelled");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "claim_browser_recording",
        expect.anything(),
      ),
    );
    await lease.release();
    const native = {};
    expect(acquireLocalNativeRecording(invoke, native)).toBe(false);
    claim.resolve(undefined);
    await rejected;
    await vi.waitFor(() =>
      expect(acquireLocalNativeRecording(invoke, native)).toBe(true),
    );
    releaseLocalNativeRecording(invoke, native);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "release_browser_recording",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("automatically retries failed release without exposing the local recorder", async () => {
    vi.useFakeTimers();
    try {
      let releases = 0;
      const invoke = vi.fn((command: string) => {
        if (command === "recording_generation") return Promise.resolve(0);
        if (command === "release_browser_recording" && ++releases === 1)
          return Promise.reject(new Error("lost response"));
        return Promise.resolve();
      });
      const lease = new BrowserRecordingLease(invoke);
      await lease.acquire();
      await expect(lease.release()).rejects.toThrow("lost response");
      const native = {};
      expect(acquireLocalNativeRecording(invoke, native)).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(releases).toBe(2);
      expect(acquireLocalNativeRecording(invoke, native)).toBe(true);
      releaseLocalNativeRecording(invoke, native);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an unconfirmed browser release while retaining local ownership", async () => {
    let releases = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(0);
      if (command === "release_browser_recording" && ++releases === 1)
        return Promise.reject(new Error("transport failed"));
      return Promise.resolve();
    });
    const lease = new BrowserRecordingLease(invoke);
    await lease.acquire();
    await expect(lease.release()).rejects.toThrow("transport failed");
    const native = {};
    expect(acquireLocalNativeRecording(invoke, native)).toBe(false);
    await lease.release();
    expect(releases).toBe(2);
    expect(acquireLocalNativeRecording(invoke, native)).toBe(true);
    releaseLocalNativeRecording(invoke, native);
  });
});

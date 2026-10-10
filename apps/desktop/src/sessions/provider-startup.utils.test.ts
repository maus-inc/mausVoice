import { describe, expect, it, vi } from "vitest";
import type { TranscriptionSession } from "../types/transcription-session.types";
import {
  LIVE_PROVIDER_STARTUP_TIMEOUT_MS,
  startLiveProviderSession,
} from "./provider-startup.utils";

const pendingSession = (
  onRecordingStart: TranscriptionSession["onRecordingStart"],
) => ({ onRecordingStart }) as TranscriptionSession;

describe("live provider startup", () => {
  it("uses a 15-second startup budget", () => {
    expect(LIVE_PROVIDER_STARTUP_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts the provider operation when startup times out", async () => {
    const controller = new AbortController();
    const onRecordingStart = vi.fn(() => new Promise<void>(() => undefined));

    await expect(
      startLiveProviderSession({
        session: pendingSession(onRecordingStart),
        sampleRate: 16_000,
        controller,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(
      "Live transcription provider startup timed out after 5ms",
    );

    expect(onRecordingStart).toHaveBeenCalledWith(16_000, controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("returns as soon as the provider reports startup readiness", async () => {
    const controller = new AbortController();
    const onRecordingStart = vi.fn().mockResolvedValue(undefined);

    await expect(
      startLiveProviderSession({
        session: pendingSession(onRecordingStart),
        sampleRate: 16_000,
        controller,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();

    expect(controller.signal.aborted).toBe(false);
  });

  it("settles promptly when the provider ignores caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Dictation canceled", "AbortError");
    const onRecordingStart = vi.fn(() => new Promise<void>(() => undefined));
    const startup = startLiveProviderSession({
      session: pendingSession(onRecordingStart),
      sampleRate: 16_000,
      controller,
      timeoutMs: 10_000,
    });
    const rejected = expect(startup).rejects.toBe(reason);

    controller.abort(reason);

    await rejected;
    expect(onRecordingStart).toHaveBeenCalledOnce();
  });

  it("removes the abort listener when provider startup throws synchronously", async () => {
    const controller = new AbortController();
    const error = new Error("provider setup failed");
    const onRecordingStart = vi.fn(() => {
      throw error;
    });
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );

    await expect(
      startLiveProviderSession({
        session: pendingSession(onRecordingStart),
        sampleRate: 16_000,
        controller,
      }),
    ).rejects.toBe(error);

    expect(onRecordingStart).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("does not start the provider when the controller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);
    const onRecordingStart = vi.fn().mockResolvedValue(undefined);

    await expect(
      startLiveProviderSession({
        session: pendingSession(onRecordingStart),
        sampleRate: 16_000,
        controller,
      }),
    ).rejects.toBe(reason);
    expect(onRecordingStart).not.toHaveBeenCalled();
  });
});

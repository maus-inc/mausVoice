import { describe, expect, it, vi } from "vitest";

vi.mock("../../router", () => ({
  browserRouter: { navigate: vi.fn() },
}));
vi.mock("../../hooks/tauri.hooks", () => ({
  useTauriListen: () => {},
}));
vi.mock("../../hooks/toast.hooks", () => ({
  useToastAction: () => {},
}));
vi.mock("../../hooks/hotkey.hooks", () => ({
  useHotkeyFire: () => {},
  useHotkeyHold: () => {},
  useHotkeyHoldMany: () => {},
}));
vi.mock("../../utils/window.utils", () => ({
  surfaceMainWindow: vi.fn(),
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(),
  }),
}));

import {
  handleEmptyTranscriptionResult,
  reportStartFailureToast,
} from "./DictationSideEffects";
import type { BaseStrategy } from "../../strategies/base.strategy";

type ToastCall = {
  message: string;
  toastType: "info" | "error";
  duration?: number;
};

type StoreCall = {
  rawTranscript: string | null;
  transcript: string | null;
  warnings: string[];
};

const baseStrategyStub = (
  overrides: Partial<BaseStrategy> = {},
): BaseStrategy =>
  ({
    shouldStoreTranscript: () => true,
    ...overrides,
  }) as unknown as BaseStrategy;

const asToastCall = (spy: ReturnType<typeof vi.fn>, index = 0): ToastCall =>
  spy.mock.calls[index]?.[0] as ToastCall;

const asStoreCall = (spy: ReturnType<typeof vi.fn>, index = 0): StoreCall =>
  spy.mock.calls[index]?.[0] as StoreCall;

describe("handleEmptyTranscriptionResult (#418)", () => {
  it("shows a recovery toast and stores a failure marker without emitting recording_failed", async () => {
    const showToast = vi.fn(async () => undefined);
    const storeTranscriptionFn = vi.fn();
    const refreshMember = vi.fn();

    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider timed out"],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast: showToast as never,
      storeTranscriptionFn: storeTranscriptionFn as never,
      refreshMember,
    });

    expect(result).toEqual({ handled: true });
    expect(showToast).toHaveBeenCalledTimes(1);
    const toastCall = asToastCall(showToast);
    expect(toastCall.toastType).toBe("error");
    expect(toastCall.message).toMatch(/transcription failed/i);
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(asStoreCall(storeTranscriptionFn)).toMatchObject({
      rawTranscript: null,
      transcript: null,
      warnings: ["provider timed out"],
    });
    // The synthetic `recording_failed` emission was removed along with the
    // `emitFailed` input: this path owns its own recovery toast, and
    // forwarding to the global listener stacked a second generic error
    // toast over it.
    expect(refreshMember).toHaveBeenCalledTimes(1);
  });

  it("skips the audio store when strategy.shouldStoreTranscript() is false", async () => {
    const showToast = vi.fn(async () => undefined);
    const storeTranscriptionFn = vi.fn();

    await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array(0), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider failed"],
      },
      strategy: baseStrategyStub({ shouldStoreTranscript: () => false }),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast: showToast as never,
      storeTranscriptionFn: storeTranscriptionFn as never,
      refreshMember: vi.fn(),
    });

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("returns handled: false when rawTranscript is non-empty (caller continues)", async () => {
    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array(0), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: "ok",
        metadata: {},
        warnings: [],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast: vi.fn() as never,
      storeTranscriptionFn: vi.fn() as never,
      refreshMember: vi.fn(),
    });

    expect(result).toEqual({ handled: false });
  });

  it("returns handled: false when warnings are empty (caller continues with no-op)", async () => {
    const showToast = vi.fn();
    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array(0), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: [],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast: showToast as never,
      storeTranscriptionFn: vi.fn() as never,
      refreshMember: vi.fn(),
    });

    expect(result).toEqual({ handled: false });
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("reportStartFailureToast (single-owner failure toast)", () => {
  const buildInput = (
    startInvokeRejected: boolean,
    showToast: ReturnType<typeof vi.fn>,
  ) => ({
    startInvokeRejected,
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
    showToast: showToast as never,
  });

  it("stays silent when the failure came from the start_recording invoke", async () => {
    // The Rust command emits `recording_failed` with the platform reason
    // before rejecting; the global listener owns that toast. A second
    // toast here would stack a duplicate "Recording failed" notification.
    const showToast = vi.fn(async () => undefined);

    await reportStartFailureToast(buildInput(true, showToast));

    expect(showToast).not.toHaveBeenCalled();
  });

  it("shows exactly one generic error toast for non-invoke start failures", async () => {
    // Covers chime playback throws, strategy.onBeforeStart, setPhase,
    // and session.onRecordingStart (provider/websocket/model-download)
    // failures, none of which emit `recording_failed`.
    const showToast = vi.fn(async () => undefined);

    await reportStartFailureToast(buildInput(false, showToast));

    expect(showToast).toHaveBeenCalledTimes(1);
    const toastCall = asToastCall(showToast);
    expect(toastCall.toastType).toBe("error");
    expect(toastCall.message).toMatch(/recording failed/i);
  });
});

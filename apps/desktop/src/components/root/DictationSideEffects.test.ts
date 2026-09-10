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
  createPhaseBookkeeper,
  handleEmptyTranscriptionResult,
  postProcessFinalizedTranscript,
} from "./DictationSideEffects";
import type { PostTranscriptInput } from "./DictationSideEffects";
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

describe("createPhaseBookkeeper", () => {
  it("records each issued phase on success", () => {
    const bookkeeper = createPhaseBookkeeper();
    const first = bookkeeper.issue();
    bookkeeper.markSent(first, "loading");
    expect(bookkeeper.getLastSent()).toBe("loading");
    const second = bookkeeper.issue();
    bookkeeper.markSent(second, "idle");
    expect(bookkeeper.getLastSent()).toBe("idle");
  });

  it("ignores a stale completion that resolves after a newer phase", () => {
    const bookkeeper = createPhaseBookkeeper();
    const stale = bookkeeper.issue();
    const latest = bookkeeper.issue();
    bookkeeper.markSent(stale, "loading");
    expect(bookkeeper.getLastSent()).toBeNull();
    bookkeeper.markSent(latest, "idle");
    expect(bookkeeper.getLastSent()).toBe("idle");
  });

  it("keeps the previous phase when a send fails so the heartbeat retries", () => {
    const bookkeeper = createPhaseBookkeeper();
    const first = bookkeeper.issue();
    bookkeeper.markSent(first, "loading");
    bookkeeper.issue();
    expect(bookkeeper.getLastSent()).toBe("loading");
  });
});

describe("postProcessFinalizedTranscript", () => {
  const buildInput = (options: { store?: boolean; agent?: boolean } = {}) => {
    const order: string[] = [];
    const handleTranscript = vi.fn<
      PostTranscriptInput["strategy"]["handleTranscript"]
    >(async () => {
      order.push("handleTranscript");
      return {
        shouldContinue: false,
        transcript: "hello world",
        sanitizedTranscript: "hello world",
        postProcessMetadata: {},
        postProcessWarnings: [],
        remoteStatus: null,
        remoteDeviceId: null,
      };
    });
    const storeTranscriptionFn = vi.fn<
      PostTranscriptInput["storeTranscriptionFn"]
    >(async () => {
      order.push("store");
      return { transcription: null, wordCount: 0 };
    });
    const strategy: PostTranscriptInput["strategy"] = {
      handleTranscript,
      shouldStoreTranscript: () => options.store !== false,
    };
    const sendIdle = vi.fn(async () => {
      order.push("idle");
    });
    const refreshMember = vi.fn(() => {
      order.push("refresh");
    });
    const input: PostTranscriptInput = {
      audio: { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      a11yInfo: null,
      appTarget: null,
      toneId: null,
      rawTranscript: "hello world",
      transcribeResult: {
        rawTranscript: "hello world",
        processedTranscript: "hello world",
        postProcessMetadata: {},
        metadata: {},
        warnings: [],
      },
      strategy,
      isAgentMode: options.agent === true,
      handleTranscriptTimeoutMs: 60_000,
      sendIdle,
      storeTranscriptionFn,
      refreshMember,
    };
    return {
      input,
      order,
      handleTranscript,
      sendIdle,
      storeTranscriptionFn,
      refreshMember,
    };
  };

  it("sends idle after handleTranscript and before storeTranscription", async () => {
    const { input, order, handleTranscript, storeTranscriptionFn } =
      buildInput();
    const result = await postProcessFinalizedTranscript(input);
    expect(result).toEqual({ shouldContinue: false });
    expect(handleTranscript).toHaveBeenCalledTimes(1);
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["handleTranscript", "idle", "store", "refresh"]);
  });

  it("propagates a post-processing failure without sending idle or persisting", async () => {
    const {
      input,
      handleTranscript,
      sendIdle,
      storeTranscriptionFn,
      refreshMember,
    } = buildInput();
    const failure = new Error("post-processing failed");
    handleTranscript.mockRejectedValueOnce(failure);

    await expect(postProcessFinalizedTranscript(input)).rejects.toThrow(
      failure,
    );
    expect(sendIdle).not.toHaveBeenCalled();
    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(refreshMember).not.toHaveBeenCalled();
  });

  it("still sends idle when the strategy skips history storage", async () => {
    const { input, order, storeTranscriptionFn } = buildInput({
      store: false,
    });
    await postProcessFinalizedTranscript(input);
    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(order).toEqual(["handleTranscript", "idle", "refresh"]);
  });

  it("sends idle up front in agent mode without skipping the post-routing idle", async () => {
    const { input, order } = buildInput({ agent: true });
    await postProcessFinalizedTranscript(input);
    expect(order).toEqual([
      "idle",
      "handleTranscript",
      "idle",
      "store",
      "refresh",
    ]);
  });
});

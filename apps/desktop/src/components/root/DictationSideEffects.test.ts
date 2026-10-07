import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  navigateMock,
  surfaceMainWindowMock,
  warningMock,
  isPersistenceAllowedMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  surfaceMainWindowMock: vi.fn(),
  warningMock: vi.fn(),
  isPersistenceAllowedMock: vi.fn(() => true),
}));

vi.mock("../../router", () => ({
  getBrowserRouter: () => ({ navigate: navigateMock }),
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
  surfaceMainWindow: surfaceMainWindowMock,
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: warningMock,
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(),
  }),
}));
vi.mock("../../utils/incognito.utils", () => ({
  isPersistenceAllowed: () => isPersistenceAllowedMock(),
  isIncognitoModeEnabled: () => !isPersistenceAllowedMock(),
  isEphemeralSessionActive: () => false,
}));

import {
  createPhaseBookkeeper,
  formatReviewPersistenceFailure,
  handleEmptyTranscriptionResult,
  postProcessFinalizedTranscript,
  surfacePersistedReviewInHistory,
} from "./DictationSideEffects";
import type {
  HandleEmptyResultInput,
  PostTranscriptInput,
} from "./DictationSideEffects";
import type { BaseStrategy } from "../../strategies/base.strategy";
import {
  flushHistoryPersist,
  resetHistoryPersistQueue,
} from "../../utils/history-persist.utils";

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

type StorageStrategy = Pick<BaseStrategy, "shouldStoreTranscript">;

const baseStrategyStub = (
  overrides: Partial<StorageStrategy> = {},
): StorageStrategy => ({
  shouldStoreTranscript: () => true,
  ...overrides,
});

const asToastCall = (spy: ReturnType<typeof vi.fn>, index = 0): ToastCall =>
  spy.mock.calls[index]?.[0] as ToastCall;

const asStoreCall = (spy: ReturnType<typeof vi.fn>, index = 0): StoreCall =>
  spy.mock.calls[index]?.[0] as StoreCall;

describe("formatReviewPersistenceFailure", () => {
  it.each([
    [
      "Incognito Mode",
      true,
      "History is unavailable in Incognito Mode. Your edited transcript remains on the pill.",
    ],
    [
      "a storage failure",
      false,
      "Could not save the edited transcript. It remains on the pill so you can retry.",
    ],
  ])(
    "uses an extractable literal message for %s",
    (_name, incognito, expected) => {
      const formatMessage = vi.fn(
        (descriptor: { defaultMessage: string }) => descriptor.defaultMessage,
      );

      expect(formatReviewPersistenceFailure(formatMessage, incognito)).toBe(
        expected,
      );
      expect(formatMessage).toHaveBeenCalledWith({ defaultMessage: expected });
    },
  );
});

describe("surfacePersistedReviewInHistory", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    surfaceMainWindowMock.mockReset();
    warningMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
    surfaceMainWindowMock.mockResolvedValue(undefined);
  });

  it("keeps durable review persistence successful when surfacing the window fails", async () => {
    surfaceMainWindowMock.mockRejectedValueOnce(
      new Error("window unavailable"),
    );

    await expect(surfacePersistedReviewInHistory()).resolves.toBeUndefined();

    expect(navigateMock).toHaveBeenCalledWith("/dashboard/transcriptions");
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining("Could not surface the saved transcript"),
    );
  });

  it("logs a navigation failure without throwing after the History row is saved", async () => {
    navigateMock.mockRejectedValueOnce(new Error("router unavailable"));

    await expect(surfacePersistedReviewInHistory()).resolves.toBeUndefined();

    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining("Could not navigate to the saved transcript"),
    );
  });
});

afterEach(() => {
  resetHistoryPersistQueue();
  isPersistenceAllowedMock.mockReturnValue(true);
});

describe("handleEmptyTranscriptionResult (#418)", () => {
  it("shows a recovery toast and stores a failure marker without emitting recording_failed", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => Promise.resolve({ transcription: null, wordCount: 0 }));
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
      showToast,
      storeTranscriptionFn,
      refreshMember,
    });

    expect(result).toEqual({ handled: true });
    expect(showToast).toHaveBeenCalledTimes(1);
    const toastCall = asToastCall(showToast);
    expect(toastCall.toastType).toBe("error");
    expect(toastCall.message).toMatch(/transcription failed/i);
    await flushHistoryPersist();
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

  it("idles the pill before scheduling the failed-transcription save", async () => {
    const order: string[] = [];
    const sendIdle = vi.fn(() => {
      order.push("idle");
      return Promise.resolve();
    });
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => {
      order.push("store");
      return Promise.resolve({ transcription: null, wordCount: 0 });
    });

    await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider timed out"],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast: () => Promise.resolve(),
      storeTranscriptionFn,
      refreshMember: vi.fn(),
      sendIdle,
    });
    await flushHistoryPersist();

    expect(sendIdle).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["idle", "store"]);
  });

  it("does not wait for the recovery toast before returning", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(
      () => new Promise(() => undefined),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => Promise.resolve({ transcription: null, wordCount: 0 }));

    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider timed out"],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(result).toEqual({ handled: true });
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("does not wait for history persistence before returning", async () => {
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => new Promise(() => undefined));

    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider timed out"],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast: () => Promise.resolve(),
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(result).toEqual({ handled: true });
    await Promise.resolve();
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue a failed-transcription row when persistence is off", async () => {
    isPersistenceAllowedMock.mockReturnValue(false);
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => Promise.resolve({ transcription: null, wordCount: 0 }));

    await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider timed out"],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });
    await flushHistoryPersist();

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(asToastCall(showToast).message).toBe("Transcription failed.");
  });

  it("skips the audio store when strategy.shouldStoreTranscript() is false", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => Promise.resolve({ transcription: null, wordCount: 0 }));

    await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array(0), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider failed"],
      },
      strategy: baseStrategyStub({ shouldStoreTranscript: () => false }),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(asToastCall(showToast).message).toBe("Transcription failed.");
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
      showToast: vi.fn<HandleEmptyResultInput["showToast"]>(),
      storeTranscriptionFn:
        vi.fn<HandleEmptyResultInput["storeTranscriptionFn"]>(),
      refreshMember: vi.fn(),
    });

    expect(result).toEqual({ handled: false });
  });

  it("returns handled: false when warnings are empty (caller continues with no-op)", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>();
    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array(0), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: [],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn:
        vi.fn<HandleEmptyResultInput["storeTranscriptionFn"]>(),
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
  const buildInput = (
    options: {
      store?: boolean;
      agent?: boolean;
      droppedChars?: number;
    } = {},
  ) => {
    const order: string[] = [];
    const handleTranscript = vi.fn<
      PostTranscriptInput["strategy"]["handleTranscript"]
    >(() => {
      order.push("handleTranscript");
      return Promise.resolve({
        shouldContinue: false,
        transcript: "hello world",
        sanitizedTranscript: "hello world",
        postProcessMetadata:
          options.droppedChars === undefined
            ? {}
            : { fastStyleTruncatedChars: options.droppedChars },
        postProcessWarnings: [],
        remoteStatus: null,
        remoteDeviceId: null,
      });
    });
    const storeTranscriptionFn = vi.fn<
      PostTranscriptInput["storeTranscriptionFn"]
    >(() => {
      order.push("store");
      return Promise.resolve({
        transcription: { id: "t1" } as never,
        wordCount: 0,
      });
    });
    const strategy: PostTranscriptInput["strategy"] = {
      handleTranscript,
      shouldStoreTranscript: () => options.store !== false,
    };
    const sendIdle = vi.fn(() => {
      order.push("idle");
      return Promise.resolve();
    });
    const refreshMember = vi.fn(() => {
      order.push("refresh");
    });
    const showToast = vi.fn(
      (_options: {
        message: string;
        toastType: "info" | "error";
        duration?: number;
      }) => {
        order.push("toast");
        return Promise.resolve();
      },
    );
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
      showToast,
    };
    return {
      input,
      order,
      handleTranscript,
      sendIdle,
      storeTranscriptionFn,
      refreshMember,
      showToast,
    };
  };

  it("tells the user when fast styling dropped the end of a long dictation", async () => {
    // The warning used to be recorded on the row and nowhere else, so the user
    // received incomplete text with no notice during dictation at all.
    const { input, showToast } = buildInput({ droppedChars: 42 });

    await postProcessFinalizedTranscript(input);
    expect(showToast).not.toHaveBeenCalled();
    await flushHistoryPersist();

    expect(showToast).toHaveBeenCalledTimes(1);
    const call = showToast.mock.calls[0]?.[0];
    expect(call?.toastType).toBe("info");
    // Promising History only after the row is durable.
    expect(call?.message).toContain("History");
  });

  it("does not promise History when the row is not stored", async () => {
    // Incognito mode skips storage, so the untruncated ending exists nowhere.
    // The same message would send the user looking for text that was never
    // written.
    isPersistenceAllowedMock.mockReturnValue(false);
    const { input, showToast } = buildInput({ store: false, droppedChars: 42 });

    await postProcessFinalizedTranscript(input);

    expect(showToast).toHaveBeenCalledTimes(1);
    const call = showToast.mock.calls[0]?.[0];
    expect(call?.message).not.toContain("History");
    expect(call?.message).toContain("42");
  });

  it("does not follow an incognito truncation notice with a History promise", async () => {
    isPersistenceAllowedMock.mockReturnValue(false);
    const { input, showToast } = buildInput({ droppedChars: 42 });

    await postProcessFinalizedTranscript(input);
    await flushHistoryPersist();

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]?.message).not.toContain("History");
  });

  it("does not call a failed History write an incognito skip", async () => {
    const { input, showToast, storeTranscriptionFn } = buildInput({
      droppedChars: 42,
    });
    storeTranscriptionFn.mockResolvedValue({
      transcription: null,
      wordCount: 0,
    });

    await postProcessFinalizedTranscript(input);
    await flushHistoryPersist();

    expect(showToast).not.toHaveBeenCalled();
  });

  it("stays quiet when nothing was truncated", async () => {
    const { input, showToast } = buildInput();
    await postProcessFinalizedTranscript(input);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("sends idle after handleTranscript and before storeTranscription", async () => {
    const { input, order, handleTranscript, storeTranscriptionFn } =
      buildInput();
    const result = await postProcessFinalizedTranscript(input);
    expect(result).toEqual({ shouldContinue: false });
    expect(handleTranscript).toHaveBeenCalledTimes(1);
    await flushHistoryPersist();
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["handleTranscript", "idle", "refresh", "store"]);
    expect(order.indexOf("idle")).toBeLessThan(order.indexOf("store"));
    expect(storeTranscriptionFn.mock.calls[0]?.[0]).toMatchObject({
      createdAt: expect.any(String),
      persistAllowedAtCapture: true,
    });
  });

  it("does not promise History when persistence was off at stop", async () => {
    isPersistenceAllowedMock.mockReturnValue(false);
    const { input, showToast } = buildInput({ droppedChars: 42 });

    await postProcessFinalizedTranscript(input);
    await flushHistoryPersist();

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]?.message).not.toContain("History");
    expect(showToast.mock.calls[0]?.[0]?.message).toContain("42");
  });

  it("promises History when the review session already stored the row", async () => {
    const { input, showToast } = buildInput({ droppedChars: 42 });
    input.strategy = {
      ...input.strategy,
      handleTranscript: vi.fn(() =>
        Promise.resolve({
          shouldContinue: false,
          transcript: "hello world",
          sanitizedTranscript: "hello world",
          postProcessMetadata: { fastStyleTruncatedChars: 42 },
          postProcessWarnings: [],
          remoteStatus: null,
          remoteDeviceId: null,
          historyOwner: "review" as const,
        }),
      ),
    };

    await postProcessFinalizedTranscript(input);
    await flushHistoryPersist();

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]?.message).toContain("History");
  });

  it("copies PCM before the persist job runs so a later mutation cannot alias it", async () => {
    const samples = new Float32Array([0.25, 0.5]);
    const { input, storeTranscriptionFn } = buildInput();
    input.audio = { samples, sampleRate: 16_000 };

    await postProcessFinalizedTranscript(input);
    samples[0] = 99;
    await flushHistoryPersist();

    const storedAudio = storeTranscriptionFn.mock.calls[0]?.[0]?.audio;
    expect(storedAudio?.samples[0]).toBeCloseTo(0.25);
  });

  it("returns to idle without waiting for history persistence", async () => {
    // A pending WAV/DB write used to keep this function (and therefore the
    // stop path's `isStopping` lock and transcribing pill) alive until History
    // finished. The next take has to be startable while that save completes.
    const { input, storeTranscriptionFn } = buildInput();
    let resolveStore: (() => void) | undefined;
    storeTranscriptionFn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStore = () => resolve({ transcription: null, wordCount: 0 });
        }),
    );

    const result = await postProcessFinalizedTranscript(input);

    expect(result).toEqual({ shouldContinue: false });
    await Promise.resolve();
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    resolveStore?.();
    await flushHistoryPersist();
  });

  it("does not store a transcript the review already persisted", async () => {
    // The review callback wrote the row, so storing here would be a second
    // transcription of the same utterance.
    const { input, storeTranscriptionFn } = buildInput();
    input.strategy = {
      ...input.strategy,
      handleTranscript: vi.fn(() =>
        Promise.resolve({
          shouldContinue: false,
          transcript: "hello world",
          sanitizedTranscript: "hello world",
          postProcessMetadata: {},
          postProcessWarnings: [],
          remoteStatus: null,
          remoteDeviceId: null,
          historyOwner: "review" as const,
        }),
      ),
    };

    await postProcessFinalizedTranscript(input);
    await flushHistoryPersist();

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
  });

  it("does not store a transcript the review left on the pill to retry from", async () => {
    // The failure toast told the user the transcript is still on the pill to
    // retry from. Storing it here anyway would contradict that and leave the
    // retry writing a duplicate row.
    const { input, storeTranscriptionFn } = buildInput();
    input.strategy = {
      ...input.strategy,
      handleTranscript: vi.fn(() =>
        Promise.resolve({
          shouldContinue: false,
          transcript: "hello world",
          sanitizedTranscript: "hello world",
          postProcessMetadata: {},
          postProcessWarnings: [],
          remoteStatus: null,
          remoteDeviceId: null,
          historyOwner: "pill" as const,
        }),
      ),
    };

    await postProcessFinalizedTranscript(input);
    await flushHistoryPersist();

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
  });

  it("stores a transcript the strategy left unowned", async () => {
    // The no-review path: nothing was written, so this is the only write.
    const { input, storeTranscriptionFn } = buildInput();
    input.strategy = {
      ...input.strategy,
      handleTranscript: vi.fn(() =>
        Promise.resolve({
          shouldContinue: false,
          transcript: "hello world",
          sanitizedTranscript: "hello world",
          postProcessMetadata: {},
          postProcessWarnings: [],
          remoteStatus: null,
          remoteDeviceId: null,
          historyOwner: "stop-path" as const,
        }),
      ),
    };

    await postProcessFinalizedTranscript(input);
    await flushHistoryPersist();

    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
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
    await flushHistoryPersist();
    expect(order).toEqual([
      "idle",
      "handleTranscript",
      "idle",
      "refresh",
      "store",
    ]);
    expect(order.lastIndexOf("idle")).toBeLessThan(order.indexOf("store"));
  });
});

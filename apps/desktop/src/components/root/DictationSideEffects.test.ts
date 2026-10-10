import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock, surfaceMainWindowMock, warningMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  surfaceMainWindowMock: vi.fn(),
  warningMock: vi.fn(),
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

import {
  createPhaseBookkeeper,
  formatReviewPersistenceFailure,
  handleEmptyTranscriptionResult,
  postProcessFinalizedTranscript,
  surfacePersistedReviewInHistory,
} from "./DictationSideEffects";
import type { Transcription } from "@maus-inc/types";
import { POST_PROCESS_ERROR_CATEGORY } from "../../actions/post-process-error-category";
import type { PostProcessMetadata } from "../../actions/transcribe.actions";
import type {
  HandleEmptyResultInput,
  PostTranscriptInput,
} from "./DictationSideEffects";
import type { BaseStrategy } from "../../strategies/base.strategy";

type ToastCall = {
  message: string;
  toastType: "info" | "error";
  duration?: number;
  action?: string;
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

describe("handleEmptyTranscriptionResult (#418)", () => {
  it("shows a recovery toast and stores a failure marker without emitting recording_failed", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(undefined),
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
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(undefined),
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
      storeResult?: boolean;
      agent?: boolean;
      droppedChars?: number;
      postProcessMetadata?: PostProcessMetadata;
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
            ? (options.postProcessMetadata ?? {})
            : {
                ...options.postProcessMetadata,
                fastStyleTruncatedChars: options.droppedChars,
              },
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
        transcription:
          options.storeResult === false ? null : ({} as Transcription),
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
        action?: string;
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

    expect(showToast).toHaveBeenCalledTimes(1);
    const call = showToast.mock.calls[0]?.[0];
    expect(call?.toastType).toBe("info");
    // The row is stored here, so promising History is accurate.
    expect(call?.message).toContain("History");
  });

  it("does not promise History when the row is not stored", async () => {
    // Incognito mode skips storage, so the untruncated ending exists nowhere.
    // The same message would send the user looking for text that was never
    // written.
    const { input, showToast } = buildInput({ store: false, droppedChars: 42 });

    await postProcessFinalizedTranscript(input);

    expect(showToast).toHaveBeenCalledTimes(1);
    const call = showToast.mock.calls[0]?.[0];
    expect(call?.message).toContain("42");
    expect(call?.message).toContain("did not save them in History");
    expect(call?.message).not.toContain("ending is in History");
  });

  it("uses the actual store result when warning about History", async () => {
    const { input, storeTranscriptionFn, showToast } = buildInput({
      storeResult: false,
      droppedChars: 42,
    });

    await postProcessFinalizedTranscript(input);

    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Fast styling left the last 42 characters unstyled. The app did not save them in History.",
        toastType: "info",
      }),
    );
  });

  it("stays quiet when nothing was truncated", async () => {
    const { input, showToast } = buildInput();
    await postProcessFinalizedTranscript(input);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("offers History only after a failed transcript was stored", async () => {
    const { input, order, showToast } = buildInput({
      postProcessMetadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });

    await postProcessFinalizedTranscript(input);

    expect(order).toEqual([
      "handleTranscript",
      "idle",
      "store",
      "refresh",
      "toast",
    ]);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Styling failed because the provider reported a quota or billing issue. The raw transcript is saved in History.",
        toastType: "error",
        duration: 8_000,
        action: "open_transcriptions",
      }),
    );
  });

  it("preserves the History action when failure and truncation feedback are combined", async () => {
    const { input, showToast } = buildInput({
      droppedChars: 42,
      postProcessMetadata: {
        postProcessFailed: true,
        postProcessFallback: false,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
      },
    });

    await postProcessFinalizedTranscript(input);

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Styling failed because the provider request or usage limit was reached. The raw transcript is saved in History. Fast styling left the last 42 characters of that dictation unstyled. The unstyled ending is in History.",
        toastType: "error",
        duration: 8_000,
        action: "open_transcriptions",
      }),
    );
  });

  it("does not claim or open History when a failed transcript was not stored", async () => {
    const { input, showToast } = buildInput({
      storeResult: false,
      postProcessMetadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
      },
    });

    await postProcessFinalizedTranscript(input);

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Styling failed because the provider request or usage limit was reached. The app did not insert the transcript or save it in History.",
        toastType: "error",
        action: undefined,
      }),
    );
  });

  it("offers settings when local styling handled a provider failure", async () => {
    const { input, showToast } = buildInput({
      postProcessMetadata: {
        postProcessFailed: false,
        postProcessFallback: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });

    await postProcessFinalizedTranscript(input);

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead.",
        toastType: "info",
        action: "open_post_processing_settings",
      }),
    );
  });

  it("keeps local-fallback and truncation feedback in one actionable toast", async () => {
    const { input, showToast } = buildInput({
      droppedChars: 42,
      postProcessMetadata: {
        postProcessFailed: false,
        postProcessFallback: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });

    await postProcessFinalizedTranscript(input);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      message:
        "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead. Fast styling left the last 42 characters of that dictation unstyled. The unstyled ending is in History.",
      toastType: "info",
      duration: 8_000,
      action: "open_post_processing_settings",
    });
  });

  it("sends idle after handleTranscript and before storeTranscription", async () => {
    const { input, order, handleTranscript, storeTranscriptionFn } =
      buildInput();
    const result = await postProcessFinalizedTranscript(input);
    expect(result).toEqual({ shouldContinue: false });
    expect(handleTranscript).toHaveBeenCalledTimes(1);
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["handleTranscript", "idle", "store", "refresh"]);
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
    expect(order).toEqual([
      "idle",
      "handleTranscript",
      "idle",
      "store",
      "refresh",
    ]);
  });
});

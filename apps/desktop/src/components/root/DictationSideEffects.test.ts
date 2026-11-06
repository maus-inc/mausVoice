import type { Transcription } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  navigateMock,
  scheduleAutomaticPostProcessEditRetryMock,
  surfaceMainWindowMock,
  warningMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  scheduleAutomaticPostProcessEditRetryMock: vi.fn(),
  surfaceMainWindowMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("../../router", () => ({
  getBrowserRouter: () => ({ navigate: navigateMock }),
}));
vi.mock("../../actions/transcriptions.actions", () => ({
  scheduleAutomaticPostProcessEditRetry:
    scheduleAutomaticPostProcessEditRetryMock,
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
import { POST_PROCESS_ERROR_CATEGORY } from "../../actions/post-process-error-category";
import type { PostProcessMetadata } from "../../actions/transcribe.actions";
import type {
  HandleEmptyResultInput,
  PostTranscriptInput,
} from "./DictationSideEffects";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { ToastAction } from "../../types/toast.types";

type ToastCall = {
  message: string;
  toastType: "info" | "error";
  duration?: number;
  action?: ToastAction;
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
  beforeEach(() => warningMock.mockClear());

  it("shows a recovery toast and stores a failure marker without emitting recording_failed", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(undefined),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() =>
      Promise.resolve({
        transcription: {
          id: "failure-row",
          createdAt: "2026-01-01T00:00:00.000Z",
          createdByUserId: "user",
          transcript: "",
          isDeleted: false,
        },
        wordCount: 0,
      }),
    );
    const refreshMember = vi.fn();

    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider timed out"],
      },
      sessionKind: "live-streaming",
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
    expect(toastCall.message).toBe(
      "Transcription failed. The recording audio was not saved.",
    );
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

  it("only claims recovery audio was saved when storage returned an audio snapshot", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(undefined),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() =>
      Promise.resolve({
        transcription: {
          id: "failure-row",
          createdAt: "2026-01-01T00:00:00.000Z",
          createdByUserId: "user",
          transcript: "",
          isDeleted: false,
          audio: { filePath: "failure.wav", durationMs: 1 },
        },
        wordCount: 0,
      }),
    );

    await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1]), sampleRate: 16_000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["provider timed out"],
      },
      sessionKind: "live-streaming",
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. Your recording is saved so you can retry.",
    );
  });

  it("retains audio when the intake subscription failed without provider warnings", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(undefined),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() =>
      Promise.resolve({
        transcription: {
          id: "failure-row",
          createdAt: "2026-01-01T00:00:00.000Z",
          createdByUserId: "user",
          transcript: "",
          isDeleted: false,
          audio: { filePath: "failure.wav", durationMs: 1 },
        },
        wordCount: 0,
      }),
    );

    await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1]), sampleRate: 16_000 },
      transcribeResult: { rawTranscript: null, metadata: {}, warnings: [] },
      sessionKind: "live-streaming",
      audioIntakeSubscriptionFailed: true,
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(asStoreCall(storeTranscriptionFn).warnings).toContain(
      "Live audio could not be sent to the transcription provider because the audio-chunk subscription failed.",
    );
    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. Your recording is saved so you can retry.",
    );
  });

  it("ignores a failed intake subscription for a batch/after-stop session", async () => {
    // The failure only disables pause pretranscription for these kinds; the
    // full recording is still transcribed at stop, so an empty provider result
    // must not gain the live-provider warning or be stored as a failure.
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>();
    const storeTranscriptionFn =
      vi.fn<HandleEmptyResultInput["storeTranscriptionFn"]>();

    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1]), sampleRate: 16_000 },
      transcribeResult: { rawTranscript: null, metadata: {}, warnings: [] },
      sessionKind: "after-stop",
      audioIntakeSubscriptionFailed: true,
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(result).toEqual({ handled: false });
    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("reports a storage failure without rejecting the stop flow", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(() =>
      Promise.resolve(undefined),
    );
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => Promise.reject(new Error("disk full")));

    await expect(
      handleEmptyTranscriptionResult({
        audio: { samples: new Float32Array([0.1]), sampleRate: 16_000 },
        transcribeResult: {
          rawTranscript: null,
          metadata: {},
          warnings: ["provider timed out"],
        },
        sessionKind: "live-streaming",
        strategy: baseStrategyStub(),
        formatMessage: (descriptor) => descriptor.defaultMessage,
        showToast,
        storeTranscriptionFn,
        refreshMember: vi.fn(),
      }),
    ).resolves.toEqual({ handled: true });

    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining("Could not preserve the failed recording"),
    );
    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. The recording audio was not saved.",
    );
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
      sessionKind: "live-streaming",
      strategy: baseStrategyStub({ shouldStoreTranscript: () => false }),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. The recording audio was not saved.",
    );
  });

  it("returns handled: false when rawTranscript is non-empty (caller continues)", async () => {
    const result = await handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array(0), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: "ok",
        metadata: {},
        warnings: [],
      },
      sessionKind: "live-streaming",
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
      sessionKind: "live-streaming",
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
      storeRejects?: boolean;
      agent?: boolean;
      droppedChars?: number;
      postProcessMetadata?: PostProcessMetadata;
      editFailed?: boolean;
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
        postProcessMetadata: {
          ...options.postProcessMetadata,
          ...(options.droppedChars === undefined
            ? undefined
            : { fastStyleTruncatedChars: options.droppedChars }),
          ...(options.editFailed === true
            ? { postProcessEditFailed: true }
            : undefined),
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
      if (options.storeRejects === true) {
        return Promise.reject(new Error("database is locked"));
      }
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

  /**
   * Runs the pipeline the way the stop path does: the pipeline resolves with
   * persistence deferred, then the caller runs the persistence step.
   */
  const runPipeline = async (input: PostTranscriptInput) => {
    const result = await postProcessFinalizedTranscript(input);
    await result.persist?.();
    return result;
  };

  it("tells the user when fast styling dropped the end of a long dictation", async () => {
    // The warning used to be recorded on the row and nowhere else, so the user
    // received incomplete text with no notice during dictation at all.
    const { input, showToast } = buildInput({ droppedChars: 42 });

    await runPipeline(input);

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

    await runPipeline(input);

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

    await runPipeline(input);

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
    await runPipeline(input);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("offers History only after a failed transcript was stored", async () => {
    const { input, order, showToast } = buildInput({
      postProcessMetadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });

    await runPipeline(input);

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

    await runPipeline(input);

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

    await runPipeline(input);

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Styling failed because the provider request or usage limit was reached. The app did not insert the transcript or save it in History.",
        toastType: "error",
        action: undefined,
      }),
    );
  });

  it("still surfaces the not-saved feedback when the history write rejects", async () => {
    // A rejected History write used to reject the whole deferred persist step,
    // which the caller only logged: the transcript was not inserted, not
    // saved, and the user got no message at all. The write failure is caught
    // like the concurrent path catches its own, so the member refresh and the
    // not-saved feedback still run.
    const { input, order, refreshMember, showToast } = buildInput({
      storeRejects: true,
      postProcessMetadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
      },
    });

    await expect(runPipeline(input)).resolves.toBeDefined();

    expect(order).toEqual([
      "handleTranscript",
      "idle",
      "store",
      "refresh",
      "toast",
    ]);
    expect(refreshMember).toHaveBeenCalledTimes(1);
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

    await runPipeline(input);

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

    await runPipeline(input);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      message:
        "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead. Fast styling left the last 42 characters of that dictation unstyled. The unstyled ending is in History.",
      toastType: "info",
      duration: 8_000,
      action: "open_post_processing_settings",
    });
  });

  it("keeps a failed edit and truncation feedback in one toast", async () => {
    const { input, showToast } = buildInput({
      droppedChars: 42,
      editFailed: true,
    });

    await runPipeline(input);

    // The pill shows one toast at a time: shown back to back, the truncation
    // report replaced the edit failure mid-read and the user only ever saw
    // one of the two outcomes.
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      message:
        "Styling was discarded because not all requested edits could be applied. The complete raw transcript is saved in History. Fast styling left the last 42 characters of that dictation unstyled. The unstyled ending is in History.",
      toastType: "error",
      duration: 8_000,
      action: "open_transcriptions",
    });
  });

  it("tells the user the raw transcript is in History once the row is stored", async () => {
    const { input, showToast, storeTranscriptionFn } = buildInput({
      editFailed: true,
    });

    await runPipeline(input);

    // The toast waits for the store call, so its promise is backed by a row.
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    const call = asToastCall(showToast);
    expect(call?.toastType).toBe("error");
    expect(call?.message).toContain("saved in History");
    expect(call?.action).toBe("open_transcriptions");
  });

  it("does not promise History when the store returns no row", async () => {
    // Persistence is allowed and the store path runs, but the write itself
    // came back empty, so the saved-in-History wording would point the user
    // at a row that does not exist.
    const { input, showToast, storeTranscriptionFn } = buildInput({
      editFailed: true,
      storeResult: false,
    });

    await runPipeline(input);

    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    const call = asToastCall(showToast);
    expect(call?.message).not.toContain("saved in History");
    expect(call?.action).toBeUndefined();
  });

  it("does not promise History for a failed edit when nothing is stored", async () => {
    // Incognito mode skips storage entirely, so the raw transcript exists
    // nowhere and the open-History action is dropped with the row.
    const { input, showToast, storeTranscriptionFn } = buildInput({
      editFailed: true,
      store: false,
    });

    await runPipeline(input);

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const call = asToastCall(showToast);
    expect(call?.message).not.toContain("saved in History");
    expect(call?.action).toBeUndefined();
  });

  it("resolves with persistence deferred until after the pill goes idle", async () => {
    const { input, order, handleTranscript, storeTranscriptionFn } =
      buildInput();
    const result = await postProcessFinalizedTranscript(input);

    // The stop path releases its gate here: the pill shows idle and storage
    // has not begun.
    expect(result.shouldContinue).toBe(false);
    expect(typeof result.persist).toBe("function");
    expect(handleTranscript).toHaveBeenCalledTimes(1);
    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(order).toEqual(["handleTranscript", "idle"]);

    await result.persist?.();
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["handleTranscript", "idle", "store", "refresh"]);
  });

  it("does not hold the pipeline on a slow store", async () => {
    // The race both reviewers flagged: storage kept the stop gate closed
    // after the pill went idle, so dictation starts clicked during a slow
    // save were dropped. The pipeline must resolve while the write is still
    // in flight, leaving persistence to run after the gate opens.
    const { input, order, storeTranscriptionFn, refreshMember } = buildInput();
    let releaseStore: (() => void) | undefined;
    storeTranscriptionFn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          order.push("store");
          releaseStore = () =>
            resolve({ transcription: {} as Transcription, wordCount: 0 });
        }),
    );

    const result = await postProcessFinalizedTranscript(input);
    const persisting = result.persist?.();
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(refreshMember).not.toHaveBeenCalled();

    releaseStore?.();
    await persisting;
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

    await runPipeline(input);

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

    await runPipeline(input);

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

    await runPipeline(input);

    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
  });

  it("schedules live recovery only after the durable row is stored", async () => {
    scheduleAutomaticPostProcessEditRetryMock.mockClear();
    const { input, storeTranscriptionFn } = buildInput();
    input.languageCode = "fr";
    const stored: Transcription = {
      id: "live-partial",
      transcript: "hello world",
      createdAt: "2026-10-06T00:00:00.000Z",
      createdByUserId: "user-1",
      isDeleted: false,
      audio: { filePath: "/tmp/live-partial.wav", durationMs: 1000 },
      postProcessEditFailed: true,
      postProcessEditFailureCount: 3,
      postProcessEditAutoRetryUsed: null,
    };
    storeTranscriptionFn.mockResolvedValueOnce({
      transcription: stored,
      wordCount: 2,
    });

    await runPipeline(input);

    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(scheduleAutomaticPostProcessEditRetryMock).toHaveBeenCalledWith({
      transcription: stored,
      toneId: null,
      languageCode: "fr",
    });
  });

  it("awaits the strategy's concurrent write instead of storing again", async () => {
    // The strategy persisted during delivery. The stop path resolves with
    // persistence deferred, and its persist step must settle that write
    // instead of storing a second row.
    const { input, order, storeTranscriptionFn } = buildInput();
    let resolvePersistence:
      ((value: { transcription: null; wordCount: number }) => void) | undefined;
    const pendingPersistence = new Promise<{
      transcription: null;
      wordCount: number;
    }>((resolve) => {
      resolvePersistence = resolve;
    });
    input.strategy = {
      ...input.strategy,
      handleTranscript: vi.fn(() => {
        order.push("handleTranscript");
        return Promise.resolve({
          shouldContinue: false,
          transcript: "hello world",
          sanitizedTranscript: "hello world",
          postProcessMetadata: {},
          postProcessWarnings: [],
          remoteStatus: null,
          remoteDeviceId: null,
          historyOwner: "concurrent" as const,
          pendingPersistence,
        });
      }),
    };

    const result = await postProcessFinalizedTranscript(input);
    expect(order).toEqual(["handleTranscript", "idle"]);

    let persisted = false;
    const persisting = result.persist?.().then(() => {
      persisted = true;
    });
    // The persist step reaches the pending write but must not settle before
    // the concurrent write does, and it never stores a second row.
    await Promise.resolve();
    expect(persisted).toBe(false);
    expect(storeTranscriptionFn).not.toHaveBeenCalled();

    resolvePersistence?.({ transcription: null, wordCount: 2 });
    await persisting;

    expect(persisted).toBe(true);
    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(order).toEqual(["handleTranscript", "idle", "refresh"]);
  });

  it("promises History for a truncated dictation persisted concurrently", async () => {
    // The concurrent owner is not `willStore`, but the row is written; the
    // truncation toast must use the stored wording, not the incognito one.
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
          historyOwner: "concurrent" as const,
          pendingPersistence: Promise.resolve({
            transcription: null,
            wordCount: 2,
          }),
        }),
      ),
    };

    await runPipeline(input);

    const call = asToastCall(showToast);
    expect(call.message).toContain("History");
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
    await runPipeline(input);
    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(order).toEqual(["handleTranscript", "idle", "refresh"]);
  });

  it("sends idle up front in agent mode without skipping the post-routing idle", async () => {
    const { input, order } = buildInput({ agent: true });
    await runPipeline(input);
    expect(order).toEqual([
      "idle",
      "handleTranscript",
      "idle",
      "store",
      "refresh",
    ]);
  });
});

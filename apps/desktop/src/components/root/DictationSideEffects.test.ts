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
      agent?: boolean;
      droppedChars?: number;
      editFailed?: boolean;
      storedRow?: boolean;
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
          ...(options.droppedChars === undefined
            ? {}
            : { fastStyleTruncatedChars: options.droppedChars }),
          ...(options.editFailed === true
            ? { postProcessEditFailed: true }
            : {}),
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
          options.storedRow === true
            ? ({ id: "stored-row" } as unknown as Transcription)
            : null,
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
    expect(call?.message).not.toContain("History");
    expect(call?.message).toContain("42");
  });

  it("stays quiet when nothing was truncated", async () => {
    const { input, showToast } = buildInput();
    await postProcessFinalizedTranscript(input);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("tells the user the raw transcript is in History once the row is stored", async () => {
    const { input, showToast, storeTranscriptionFn } = buildInput({
      editFailed: true,
      storedRow: true,
    });

    await postProcessFinalizedTranscript(input);

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
    });

    await postProcessFinalizedTranscript(input);

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

    await postProcessFinalizedTranscript(input);

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const call = asToastCall(showToast);
    expect(call?.message).not.toContain("saved in History");
    expect(call?.action).toBeUndefined();
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

    await postProcessFinalizedTranscript(input);

    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(scheduleAutomaticPostProcessEditRetryMock).toHaveBeenCalledWith({
      transcription: stored,
      toneId: null,
      languageCode: "fr",
    });
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

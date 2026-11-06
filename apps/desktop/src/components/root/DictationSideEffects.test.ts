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
  formatReviewPersistenceFailure,
  handleEmptyTranscriptionResult,
  postProcessFinalizedTranscript,
  surfacePersistedReviewInHistory,
} from "./DictationSideEffects";
import { createPhaseBookkeeper } from "./dictation-phase.hooks";
import type {
  HandleEmptyResultInput,
  PostTranscriptInput,
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
    ["Incognito Mode", true, "History is unavailable in Incognito Mode."],
    [
      "a storage failure",
      false,
      "Could not confirm that the edited transcript was saved in History.",
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

  it("does not navigate a successor after a delayed window handoff", async () => {
    let finish!: () => void;
    surfaceMainWindowMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    let current = true;
    const pending = surfacePersistedReviewInHistory(() => current);
    current = false;
    finish();
    await pending;
    expect(navigateMock).not.toHaveBeenCalled();
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
  it("does not notify or refresh a successor when failure audio storage settles late", async () => {
    let finish!: (value: { transcription: null; wordCount: number }) => void;
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const showToast = vi.fn();
    const refreshMember = vi.fn();
    let current = true;
    const pending = handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["failure"],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember,
      isCurrent: () => current,
    });
    current = false;
    finish({ transcription: null, wordCount: 0 });
    await pending;
    expect(showToast).not.toHaveBeenCalled();
    expect(refreshMember).not.toHaveBeenCalled();
  });

  it("refreshes without waiting for a toast and ignores its stale rejection", async () => {
    warningMock.mockClear();
    let reject!: (error: Error) => void;
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>(
      () =>
        new Promise((_, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const refreshMember = vi.fn();
    let current = true;
    const pending = handleEmptyTranscriptionResult({
      audio: { samples: new Float32Array([0.1]), sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["failure"],
      },
      strategy: baseStrategyStub(),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn: vi.fn(async () => ({
        transcription: null,
        wordCount: 0,
      })),
      refreshMember,
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledOnce());
    await expect(pending).resolves.toEqual({ handled: true });
    expect(refreshMember).toHaveBeenCalledOnce();
    warningMock.mockClear();
    current = false;
    reject(new Error("toast failed"));
    await Promise.resolve();
    expect(refreshMember).toHaveBeenCalledOnce();
    expect(warningMock).not.toHaveBeenCalled();
  });

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
    expect(toastCall.message).toBe(
      "Transcription failed. Your recording was not saved.",
    );
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(storeTranscriptionFn.mock.invocationCallOrder[0]).toBeLessThan(
      showToast.mock.invocationCallOrder[0],
    );
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

  it.each([true, false])(
    "reports whether a partial capture was saved: %s",
    async (saved) => {
      const showToast = vi.fn<HandleEmptyResultInput["showToast"]>();
      const storeTranscriptionFn = vi.fn<
        HandleEmptyResultInput["storeTranscriptionFn"]
      >(async () => ({
        transcription: saved
          ? {
              id: "saved",
              createdAt: "2026-01-01",
              createdByUserId: "user",
              isDeleted: false,
              transcript: "[Transcription Failed]",
              audio: { filePath: "/saved/audio.wav", durationMs: 50 },
            }
          : null,
        wordCount: 0,
      }));
      const audio = { samples: [0.1], sampleRate: 16000, captureFailed: true };
      await handleEmptyTranscriptionResult({
        audio,
        transcribeResult: {
          rawTranscript: null,
          metadata: {},
          warnings: ["capture failed"],
        },
        strategy: baseStrategyStub(),
        formatMessage: ({ defaultMessage }) => defaultMessage,
        showToast,
        storeTranscriptionFn,
        refreshMember: vi.fn(),
      });
      expect(storeTranscriptionFn.mock.calls[0]?.[0].audio).toBe(audio);
      expect(asToastCall(showToast, 0).message).toContain(
        "The microphone may still be in use.",
      );
      const firstSafetyOwner =
        showToast.mock.calls[0]?.[0].microphoneSafetyOwner;
      expect(firstSafetyOwner).toEqual(expect.any(String));
      expect(showToast.mock.calls[1]?.[0].microphoneSafetyOwner).toBe(
        firstSafetyOwner,
      );
      expect(asToastCall(showToast, 1).message).toBe(
        saved
          ? "The recording may be incomplete. A partial recording was saved. The microphone may still be in use. If its indicator stays on, quit the app."
          : "The recording may be incomplete. The partial recording was not saved. The microphone may still be in use. If its indicator stays on, quit the app.",
      );
    },
  );

  it("warns about the microphone before a stalled partial-audio save", () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>();
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(() => new Promise(() => {}));
    void handleEmptyTranscriptionResult({
      audio: { samples: [0.1], sampleRate: 16000, captureFailed: true },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["capture failed"],
      },
      strategy: baseStrategyStub(),
      formatMessage: ({ defaultMessage }) => defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });
    expect(storeTranscriptionFn).toHaveBeenCalledOnce();
    expect(asToastCall(showToast).message).toContain(
      "microphone may still be in use",
    );
    expect(showToast.mock.invocationCallOrder[0]).toBeLessThan(
      storeTranscriptionFn.mock.invocationCallOrder[0],
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
      strategy: baseStrategyStub({ shouldStoreTranscript: () => false }),
      formatMessage: (descriptor) => descriptor.defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });

    expect(storeTranscriptionFn).not.toHaveBeenCalled();
    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. Your recording was not saved.",
    );
  });

  it("promises recovery only after an audio snapshot has been saved", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>();
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(async () => ({
      transcription: {
        id: "saved",
        createdAt: "2026-01-01",
        createdByUserId: "user",
        isDeleted: false,
        transcript: "[Transcription Failed]",
        audio: { filePath: "/saved/audio.wav", durationMs: 50 },
      },
      wordCount: 0,
    }));
    await handleEmptyTranscriptionResult({
      audio: { samples: [0.1], sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["failed"],
      },
      strategy: baseStrategyStub(),
      formatMessage: ({ defaultMessage }) => defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });
    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. Your recording is saved so you can retry.",
    );
  });

  it("does not promise audio recovery for a saved failure marker without audio", async () => {
    const showToast = vi.fn<HandleEmptyResultInput["showToast"]>();
    const storeTranscriptionFn = vi.fn<
      HandleEmptyResultInput["storeTranscriptionFn"]
    >(async () => ({
      transcription: {
        id: "saved",
        createdAt: "2026-01-01",
        createdByUserId: "user",
        isDeleted: false,
        transcript: "[Transcription Failed]",
      },
      wordCount: 0,
    }));
    await handleEmptyTranscriptionResult({
      audio: { samples: [0.1], sampleRate: 16000 },
      transcribeResult: {
        rawTranscript: null,
        metadata: {},
        warnings: ["failed"],
      },
      strategy: baseStrategyStub(),
      formatMessage: ({ defaultMessage }) => defaultMessage,
      showToast,
      storeTranscriptionFn,
      refreshMember: vi.fn(),
    });
    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. Your recording was not saved.",
    );
  });

  it("continues recovery if persistence or the toast fails", async () => {
    const showToast = vi
      .fn<HandleEmptyResultInput["showToast"]>()
      .mockRejectedValue(new Error("toast failed"));
    const storeTranscriptionFn = vi
      .fn<HandleEmptyResultInput["storeTranscriptionFn"]>()
      .mockRejectedValue(new Error("storage failed"));
    const refreshMember = vi.fn();
    await expect(
      handleEmptyTranscriptionResult({
        audio: { samples: [0.1], sampleRate: 16000 },
        transcribeResult: {
          rawTranscript: null,
          metadata: {},
          warnings: ["failed"],
        },
        strategy: baseStrategyStub(),
        formatMessage: ({ defaultMessage }) => defaultMessage,
        showToast,
        storeTranscriptionFn,
        refreshMember,
      }),
    ).resolves.toEqual({ handled: true });
    expect(asToastCall(showToast).message).toBe(
      "Transcription failed. Your recording was not saved.",
    );
    expect(refreshMember).toHaveBeenCalledOnce();
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
        transcription: {
          id: "saved",
          createdAt: "2026-01-01T00:00:00.000Z",
          createdByUserId: "user",
          transcript: "hello world",
          rawTranscript: "hello world",
          isDeleted: false,
        },
        wordCount: 2,
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
    expect(call?.message).toContain("omitted the last 42 characters");
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
    expect(call?.message).toContain("could not be confirmed");
    expect(call?.message).toContain("42");
  });

  it("does not hold the stop pipeline open for a stalled truncation toast", async () => {
    const { input, storeTranscriptionFn } = buildInput({ droppedChars: 42 });
    input.showToast = () => new Promise<void>(() => {});
    const result = await Promise.race([
      postProcessFinalizedTranscript(input),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 100),
      ),
    ]);
    expect(result).toEqual({ shouldContinue: false });
    expect(storeTranscriptionFn).toHaveBeenCalledOnce();
  });

  it("does not claim History was saved when storage returns no row", async () => {
    const { input, showToast, storeTranscriptionFn } = buildInput({
      droppedChars: 42,
    });
    storeTranscriptionFn.mockResolvedValueOnce({
      transcription: null,
      wordCount: 0,
    });
    await postProcessFinalizedTranscript(input);
    const message = showToast.mock.calls[0]?.[0].message;
    expect(message).toContain("could not be confirmed");
    expect(message).not.toContain("incognito");
  });

  it.each([
    ["review", true],
    ["pill", false],
  ] as const)(
    "reports review history accurately for owner %s",
    async (historyOwner, saved) => {
      const { input, showToast, storeTranscriptionFn } = buildInput({
        droppedChars: 42,
      });
      input.strategy.handleTranscript = vi.fn().mockResolvedValue({
        shouldContinue: false,
        transcript: "hello world",
        sanitizedTranscript: "hello world",
        postProcessMetadata: { fastStyleTruncatedChars: 42 },
        postProcessWarnings: [],
        historyOwner,
      });
      await postProcessFinalizedTranscript(input);
      const message = showToast.mock.calls[0]?.[0].message;
      expect(message?.includes("could not be confirmed")).toBe(!saved);
      expect(storeTranscriptionFn).not.toHaveBeenCalled();
    },
  );

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
    expect(storeTranscriptionFn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["handleTranscript", "idle", "store", "refresh"]);
  });

  it("does not invoke an agent strategy if its idle phase retires the owner", async () => {
    const { input, handleTranscript } = buildInput({ agent: true });
    let current = true;
    input.isCurrent = () => current;
    input.sendIdle = () => {
      current = false;
      return Promise.resolve();
    };
    await expect(postProcessFinalizedTranscript(input)).resolves.toEqual({
      shouldContinue: false,
    });
    expect(handleTranscript).not.toHaveBeenCalled();
  });

  it.each(["idle", "storage decision"] as const)(
    "does not dispatch storage if the %s retires the owner",
    async (step) => {
      const { input, storeTranscriptionFn, refreshMember } = buildInput();
      let current = true;
      input.isCurrent = () => current;
      if (step === "idle")
        input.sendIdle = () => {
          current = false;
          return Promise.resolve();
        };
      else
        input.strategy.shouldStoreTranscript = () => {
          current = false;
          return true;
        };
      await expect(postProcessFinalizedTranscript(input)).resolves.toEqual({
        shouldContinue: false,
      });
      expect(storeTranscriptionFn).not.toHaveBeenCalled();
      expect(refreshMember).not.toHaveBeenCalled();
    },
  );

  it("does not send idle or store a result after its owner is replaced", async () => {
    const { input, sendIdle, storeTranscriptionFn } = buildInput();
    let finish!: (
      value: Awaited<
        ReturnType<PostTranscriptInput["strategy"]["handleTranscript"]>
      >,
    ) => void;
    input.strategy.handleTranscript = vi.fn<
      PostTranscriptInput["strategy"]["handleTranscript"]
    >(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let current = true;
    input.isCurrent = () => current;
    const result = postProcessFinalizedTranscript(input);
    current = false;
    finish({
      shouldContinue: false,
      transcript: "old",
      sanitizedTranscript: "old",
      postProcessMetadata: {},
      postProcessWarnings: [],
    });
    await expect(result).resolves.toEqual({ shouldContinue: false });
    expect(sendIdle).not.toHaveBeenCalled();
    expect(storeTranscriptionFn).not.toHaveBeenCalled();
  });

  it("does not refresh a successor when transcript storage settles late", async () => {
    const { input, refreshMember, showToast } = buildInput({
      droppedChars: 42,
    });
    let finish!: (
      result: Awaited<ReturnType<PostTranscriptInput["storeTranscriptionFn"]>>,
    ) => void;
    input.storeTranscriptionFn = vi.fn<
      PostTranscriptInput["storeTranscriptionFn"]
    >(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let current = true;
    input.isCurrent = () => current;
    const result = postProcessFinalizedTranscript(input);
    await vi.waitFor(() =>
      expect(input.storeTranscriptionFn).toHaveBeenCalledOnce(),
    );
    current = false;
    finish({ transcription: null, wordCount: 0 });
    await expect(result).resolves.toEqual({ shouldContinue: false });
    expect(refreshMember).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("retires a slow strategy when the post-processing deadline fires", async () => {
    vi.useFakeTimers();
    try {
      const { input } = buildInput();
      let isCurrent: (() => boolean) | undefined;
      input.strategy.handleTranscript = vi.fn<
        PostTranscriptInput["strategy"]["handleTranscript"]
      >((params) => {
        isCurrent = params.isCurrent;
        return new Promise(() => {});
      });
      input.handleTranscriptTimeoutMs = 10;
      const result = postProcessFinalizedTranscript(input);
      const rejection = expect(result).rejects.toThrow("timed out");
      expect(isCurrent?.()).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(isCurrent?.()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores the transcript even if the idle phase reply never arrives", async () => {
    const { input, storeTranscriptionFn } = buildInput();
    input.sendIdle = vi.fn(() => new Promise<void>(() => {}));
    const outcome = await Promise.race([
      postProcessFinalizedTranscript(input),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);
    expect(outcome).toEqual({ shouldContinue: false });
    expect(storeTranscriptionFn).toHaveBeenCalledOnce();
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

  it("does not duplicate a review write with an unconfirmed result", async () => {
    // A failed IPC can lose its reply after committing; a new row ID is unsafe.
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
          historyOwner: "review-unconfirmed" as const,
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

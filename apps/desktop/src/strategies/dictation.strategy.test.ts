import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPreferences } from "../actions/user.actions";
import { POST_PROCESS_ERROR_CATEGORY } from "../actions/post-process-error-category";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import type { HandleTranscriptParams } from "../types/strategy.types";
import { LOCAL_USER_ID } from "../utils/user.utils";
import { DictationStrategy } from "./dictation.strategy";

const {
  invokeMock,
  routeTranscriptOutputMock,
  appendToDictationBacklogMock,
  clearDictationBacklogMock,
  drainDictationBacklogMock,
  hasDictationBacklogMock,
  incrementDictationBacklogNonceMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  routeTranscriptOutputMock: vi.fn(async (args: { text: string }) => ({
    delivered: true,
    remote: false,
    deliveredText: args.text.length > 0 ? args.text : null,
  })),
  appendToDictationBacklogMock: vi.fn(),
  clearDictationBacklogMock: vi.fn(),
  drainDictationBacklogMock: vi.fn(async () => ({
    delivered: true,
    copiedToClipboard: false,
  })),
  hasDictationBacklogMock: vi.fn(() => false),
  incrementDictationBacklogNonceMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("../utils/output-routing.utils", () => ({
  routeTranscriptOutput: routeTranscriptOutputMock,
  appendToDictationBacklog: appendToDictationBacklogMock,
  clearDictationBacklog: clearDictationBacklogMock,
  drainDictationBacklog: drainDictationBacklogMock,
  hasDictationBacklog: hasDictationBacklogMock,
  incrementDictationBacklogNonce: incrementDictationBacklogNonceMock,
}));

vi.mock("../actions/app.actions", () => ({
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));
vi.mock("../i18n/intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n/intl")>();
  return {
    ...actual,
    getIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});
vi.mock("../actions/toast.actions", async () => ({
  runToast: (await import("../../test/helpers/toast-mock")).runToastMock,
  showToast: vi.fn(),
}));
vi.mock("../actions/app-target.actions", () => ({
  tryRegisterCurrentAppTarget: vi.fn(async () => null),
}));
vi.mock("../actions/transcribe.actions", () => ({
  postProcessTranscript: vi.fn(),
}));

// The strategy logs expected failures in these tests; keep the native log
// bridge out of the node environment.
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    verbose: () => undefined,
    info: () => undefined,
    warning: () => undefined,
    error: () => undefined,
  }),
}));
vi.mock("../utils/overlay.utils", () => ({
  sendPillStageText: vi.fn(),
}));
vi.mock("../i18n/intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n/intl")>();
  return {
    ...actual,
    getIntl: () => ({
      // Interpolates values the way react-intl does, so a test asserting the
      // rendered string cannot pass against a `{placeholder}` left unfilled.
      formatMessage: (
        descriptor: { defaultMessage: string },
        values?: Record<string, string>,
      ) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          descriptor.defaultMessage,
        ),
    }),
  };
});

const seedState = () => {
  const state = structuredClone(INITIAL_APP_STATE);
  // Real-time interim routing runs only in Verbatim with a manually selected
  // style; seed exactly that shape so handleInterimSegment does not bail.
  state.toneById = {
    verbatim: {
      id: "verbatim",
      name: "Verbatim",
      promptTemplate: "",
      isSystem: true,
      createdAt: 0,
      sortOrder: 0,
    },
  };
  state.userById[LOCAL_USER_ID] = {
    id: LOCAL_USER_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: "Tester",
    onboarded: true,
    playInteractionChime: false,
    hasFinishedTutorial: true,
    wordsThisMonth: 0,
    wordsTotal: 0,
    stylingMode: "manual",
    selectedToneId: "verbatim",
    activeToneIds: ["verbatim"],
  };
  state.userPrefs = {
    ...createDefaultPreferences(),
    userId: LOCAL_USER_ID,
    realtimeOutputEnabled: true,
    spokenCommandsEnabled: true,
    hallucinationFilterEnabled: false,
  };
  setAppState(state, true);
};

const setTargetState = (state: "editable" | "not_editable" | "unknown") => {
  invokeMock.mockImplementation((command: string) => {
    if (command === "check_focused_paste_target") {
      return Promise.resolve(state);
    }
    return Promise.resolve(undefined);
  });
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createHandleTranscriptParams = (
  overrides: Partial<HandleTranscriptParams> = {},
): HandleTranscriptParams => ({
  rawTranscript: "raw transcript",
  toneId: null,
  a11yInfo: null,
  currentApp: null,
  loadingToken: null,
  audio: { samples: [], sampleRate: 16000 },
  transcriptionMetadata: {},
  transcriptionWarnings: [],
  ...overrides,
});

/**
 * The payload of the nth `showToast` call.
 *
 * These assertions used to read `mock.calls[0]![0]`, and a regression that
 * stopped showing a toast surfaced as a `TypeError` reading `.message` of
 * `undefined` -- which says the toast was absent but not that none was shown.
 */
const toastCall = <T>(
  mocked: { mock: { calls: readonly unknown[][] } },
  call = 0,
): T => {
  const args = mocked.mock.calls[call];
  if (!args) {
    throw new Error(
      `Expected showToast to be called at index ${call}, but it was called ${mocked.mock.calls.length} time(s)`,
    );
  }
  const payload = args[0];
  if (payload === undefined) {
    throw new Error(`Expected showToast call ${call} to carry a payload`);
  }
  return payload as T;
};

describe("DictationStrategy backlog lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasDictationBacklogMock.mockReturnValue(false);
    drainDictationBacklogMock.mockResolvedValue({
      delivered: true,
      copiedToClipboard: false,
    });
    seedState();
    setTargetState("editable");
  });

  it("awaits app-target resolution before onBeforeStart completes", async () => {
    const targetRequested = deferred<void>();
    const targetGate = deferred<null>();
    const { tryRegisterCurrentAppTarget } =
      await import("../actions/app-target.actions");
    vi.mocked(tryRegisterCurrentAppTarget).mockImplementationOnce(() => {
      targetRequested.resolve();
      return targetGate.promise;
    });

    const strategy = new DictationStrategy();
    let settled = false;
    const startPromise = strategy.onBeforeStart().then(() => {
      settled = true;
    });

    await targetRequested.promise;
    expect(settled).toBe(false);
    expect(clearDictationBacklogMock).toHaveBeenCalledTimes(1);
    expect(incrementDictationBacklogNonceMock).toHaveBeenCalledTimes(1);

    targetGate.resolve(null);
    await startPromise;
    expect(settled).toBe(true);
  });

  it("advances the session nonce on cleanup so stale drains self-invalidate", async () => {
    const strategy = new DictationStrategy();
    incrementDictationBacklogNonceMock.mockClear();
    await strategy.cleanup();
    expect(incrementDictationBacklogNonceMock).toHaveBeenCalledTimes(1);
  });

  // The remote interim path had no test at all, which is why it shipped without
  // `isInterim`. `RouteTranscriptOutputArgs.isInterim` documents that a realtime
  // interim segment must bypass the hands-free delay, and all three consequences of
  // omitting it are in `output-routing.utils.ts`: `:217` awaits up to
  // `MAX_HANDS_FREE_DELAY_MS` (60s) per segment and those waits serialise on the
  // paste queue, so remote interim text arrived as one burst at the end; `:178`
  // fires the "Inserting" pill stage; `:237` calls `beginEditWatch`, a clipboard
  // read and a toast dismissal.
  it("marks a remote interim segment as interim so it skips the hands-free delay", async () => {
    seedState();
    const state = getAppState();
    // Built the way `seedState` builds it rather than by spreading the seeded
    // prefs: `userPrefs` is `Nullable<UserPreferences>`, so spreading it widens the
    // required `userId` to `string | undefined` and does not type-check.
    state.userPrefs = {
      ...createDefaultPreferences(),
      userId: LOCAL_USER_ID,
      realtimeOutputEnabled: true,
      spokenCommandsEnabled: true,
      hallucinationFilterEnabled: false,
      remoteOutputEnabled: true,
      remoteTargetDeviceId: "device-1",
    };
    setAppState(state, true);
    const strategy = new DictationStrategy();

    // `handleInterimSegment` dispatches through `void this.enqueuePasteWork(...)`,
    // so the routing lands on a later tick. My first version of this test asserted
    // synchronously and saw zero calls, which reads exactly like a product bug and
    // is not one.
    strategy.handleInterimSegment("remote interim");

    await vi.waitFor(() => {
      expect(routeTranscriptOutputMock).toHaveBeenCalledWith(
        expect.objectContaining({ isInterim: true }),
      );
    });

    // `isInterim: true` on its own does not prove the REMOTE branch ran, because
    // the local branch sets the same flag -- switching remote output off left this
    // assertion green. That is the control that has to fail. The remote branch is
    // documented as bypassing the backlog, so the backlog probes are what
    // distinguish it. Without them the test would keep passing if the remote
    // condition broke and every segment silently took the local path instead,
    // which is the same class of bug this is meant to catch.
    expect(hasDictationBacklogMock).not.toHaveBeenCalled();
    expect(appendToDictationBacklogMock).not.toHaveBeenCalled();
  });

  it("keeps pasting interim segments after a queued callback rejects", async () => {
    const strategy = new DictationStrategy();
    const firstBacklogAttempt = deferred<void>();
    const secondSegmentRouted = deferred<void>();
    setTargetState("not_editable");
    appendToDictationBacklogMock.mockImplementationOnce(() => {
      firstBacklogAttempt.resolve();
      throw new Error("store blew up");
    });

    strategy.handleInterimSegment("first");
    await firstBacklogAttempt.promise;

    setTargetState("editable");
    hasDictationBacklogMock.mockReturnValue(false);
    routeTranscriptOutputMock.mockImplementationOnce(async () => {
      secondSegmentRouted.resolve();
      return {
        delivered: true,
        remote: false,
        deliveredText: "second ",
      };
    });
    strategy.handleInterimSegment("second");
    await secondSegmentRouted.promise;

    expect(routeTranscriptOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second " }),
    );
  });

  it("serializes the finalize drain with a polled drain (no double delivery)", async () => {
    const strategy = new DictationStrategy();
    const firstSegmentBacklogged = deferred<void>();

    // One segment lands in the backlog.
    setTargetState("not_editable");
    appendToDictationBacklogMock.mockImplementationOnce(() => {
      firstSegmentBacklogged.resolve();
    });
    strategy.handleInterimSegment("hello");
    await firstSegmentBacklogged.promise;
    expect(appendToDictationBacklogMock).toHaveBeenCalledTimes(1);

    // The finalize drain blocks mid-delivery; a poll that fired during it
    // must not start a second concurrent drain of the same snapshot.
    let backlog = true;
    const drainStarted = deferred<void>();
    const drainRelease = deferred<{
      delivered: boolean;
      copiedToClipboard: boolean;
    }>();
    hasDictationBacklogMock.mockImplementation(() => backlog);
    drainDictationBacklogMock.mockImplementation(() => {
      drainStarted.resolve();
      return drainRelease.promise.then((result) => {
        backlog = false;
        return result;
      });
    });
    setTargetState("editable");

    const finalized = strategy.handleTranscript(
      createHandleTranscriptParams({ rawTranscript: "hello" }),
    );
    await drainStarted.promise;
    const polled = strategy.checkAndDrainBacklog();

    drainRelease.resolve({ delivered: true, copiedToClipboard: false });
    await finalized;
    await polled;

    expect(drainDictationBacklogMock).toHaveBeenCalledTimes(1);
  });

  it("persists the edited review text as soon as it is delivered", async () => {
    const persistReviewedTranscript = vi.fn().mockResolvedValue(true);
    routeTranscriptOutputMock.mockResolvedValueOnce({
      delivered: true,
      remote: false,
      deliveredText: "edited in the pill",
    });

    const result = await new DictationStrategy().handleTranscript(
      createHandleTranscriptParams({
        processedTranscript: "clean transcript",
        serverPostProcessMetadata: { postProcessModel: "review-model" },
        persistReviewedTranscript,
      }),
    );

    expect(persistReviewedTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "edited in the pill",
        sanitizedTranscript: "raw transcript",
        postProcessMetadata: { postProcessModel: "review-model" },
      }),
    );
    expect(result).toMatchObject({
      transcript: "edited in the pill",
      historyOwner: "review",
    });
  });

  it("reports the review as the row's owner when its persistence failed", async () => {
    // The failure toast tells the user the transcript is still on the pill to
    // retry from, so the row is the pill's. Reporting it as unowned would let
    // the stop path write it too, and the retry would duplicate it.
    const persistReviewedTranscript = vi.fn().mockResolvedValue(false);
    routeTranscriptOutputMock.mockResolvedValueOnce({
      delivered: true,
      remote: false,
      deliveredText: "edited in the pill",
    });

    const result = await new DictationStrategy().handleTranscript(
      createHandleTranscriptParams({
        processedTranscript: "clean transcript",
        persistReviewedTranscript,
      }),
    );

    expect(result).toMatchObject({
      transcript: "edited in the pill",
      historyOwner: "pill",
    });
  });

  it("leaves the row to the stop path when no review edit was made", async () => {
    const result = await new DictationStrategy().handleTranscript(
      createHandleTranscriptParams({ processedTranscript: "clean transcript" }),
    );

    expect(result).toMatchObject({ historyOwner: "stop-path" });
  });

  it("uses the text inserted after review as the History transcript", async () => {
    routeTranscriptOutputMock.mockResolvedValueOnce({
      delivered: true,
      remote: false,
      deliveredText: "edited in the pill",
    });

    const args: HandleTranscriptParams = {
      rawTranscript: "raw transcript",
      processedTranscript: "clean transcript",
      toneId: null,
      a11yInfo: null,
      currentApp: null,
      loadingToken: null,
      audio: { samples: [], sampleRate: 16000 },
      transcriptionMetadata: {},
      transcriptionWarnings: [],
    };
    const result = await new DictationStrategy().handleTranscript(args);

    expect(result).toMatchObject({
      transcript: "edited in the pill",
      sanitizedTranscript: "raw transcript",
    });
  });

  it("preserves the fallback transcript without inserting after post-processing fails", async () => {
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "fallback raw text",
      warnings: [POST_PROCESS_ERROR_CATEGORY.quotaOrPayment],
      metadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });
    const { showToast } = await import("../actions/toast.actions");

    const args: HandleTranscriptParams = {
      rawTranscript: "fallback raw text",
      toneId: "custom-tone",
      a11yInfo: null,
      currentApp: null,
      loadingToken: null,
      audio: { samples: [], sampleRate: 16000 },
      transcriptionMetadata: {},
      transcriptionWarnings: [],
    };
    const result = await new DictationStrategy().handleTranscript(args);

    expect(routeTranscriptOutputMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Styling failed: Quota or payment required. The raw transcript is saved in History.",
        toastType: "error",
      }),
    );
    expect(result).toMatchObject({
      transcript: "fallback raw text",
      postProcessMetadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });
  });

  it("does not claim the local style ran when the provider reply was unusable", async () => {
    // `postProcessFallback` is set on TWO different runs, and
    // `transcriptions.actions.ts` says so in its own words: "covers two different runs
    // and cannot be read on its own". This reads it bare, so it fires for both.
    //
    //   the request FAILED, the local style succeeded -> postProcessError set.
    //     The text really is styled, and the toast is true.
    //   the request SUCCEEDED but the reply was unusable (truncated JSON, prose, `{}`)
    //     -> postProcessFailed stays false and no error is recorded
    //     (transcribe.actions.ts:402-408, "The request succeeded, so postProcessFailed
    //     stays false"). The text stored is the raw ASR, and no local style ran.
    //
    // The second case used to tell the user "Online styling was unavailable, so the
    // local style was used instead" -- which is the opposite of what happened. The row
    // is still marked unstyled by `isUnstyledPostProcess`, so History shows the real
    // state; this only stops the toast asserting something false.
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "so um I went to the store",
      warnings: ["Post-processing returned an unusable response."],
      metadata: {
        postProcessFailed: false,
        postProcessFallback: true,
      },
    });
    const { showToast } = await import("../actions/toast.actions");
    vi.mocked(showToast).mockClear();

    await new DictationStrategy().handleTranscript({
      rawTranscript: "so um I went to the store",
      toneId: "custom-tone",
      a11yInfo: null,
      currentApp: null,
      loadingToken: null,
      audio: { samples: [], sampleRate: 16000 },
      transcriptionMetadata: {},
      transcriptionWarnings: [],
    } satisfies HandleTranscriptParams);

    const messages = vi
      .mocked(showToast)
      .mock.calls.map((call) => call[0]?.message);
    expect(messages).not.toContain(
      "Online styling was unavailable, so the local style was used instead.",
    );
  });

  it("still says the local style ran when the provider request actually failed", async () => {
    // The control for the case above: this is the run the message is written for, and
    // gating on the separator must not silence it.
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "I went to the store",
      warnings: ["Fast local style applied instead of the LLM post-processor."],
      metadata: {
        postProcessFailed: false,
        postProcessFallback: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });
    const { showToast } = await import("../actions/toast.actions");
    vi.mocked(showToast).mockClear();

    await new DictationStrategy().handleTranscript({
      rawTranscript: "I went to the store",
      toneId: "custom-tone",
      a11yInfo: null,
      currentApp: null,
      loadingToken: null,
      audio: { samples: [], sampleRate: 16000 },
      transcriptionMetadata: {},
      transcriptionWarnings: [],
    } satisfies HandleTranscriptParams);

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Online styling was unavailable, so the local style was used instead.",
      }),
    );
  });

  it("routes final output without an arbitrary delay", async () => {
    const routed = deferred<void>();
    routeTranscriptOutputMock.mockImplementationOnce(async () => {
      routed.resolve();
      return {
        delivered: true,
        remote: false,
        deliveredText: "clean transcript ",
      };
    });
    const strategy = new DictationStrategy();
    const completion = strategy.handleTranscript(
      createHandleTranscriptParams({ processedTranscript: "clean transcript" }),
    );

    // A final transcript has no readiness event to wait for here. Routing it
    // must proceed in the same task rather than depend on an unexplained
    // fixed delay that slows every dictation and makes the outcome timer-led.
    await routed.promise;
    expect(routeTranscriptOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "clean transcript " }),
      null,
    );
    await expect(completion).resolves.toMatchObject({
      transcript: "clean transcript",
    });
  });

  it("re-backlogs the new segment when the combined drain fails", async () => {
    const strategy = new DictationStrategy();
    const firstSegmentBacklogged = deferred<void>();
    const secondSegmentBacklogged = deferred<void>();

    const backlog: string[] = [];
    appendToDictationBacklogMock.mockImplementation((text: string) => {
      backlog.push(text);
      if (text === "alpha") {
        firstSegmentBacklogged.resolve();
      } else if (text === "beta") {
        secondSegmentBacklogged.resolve();
      }
    });
    hasDictationBacklogMock.mockImplementation(() => backlog.length > 0);

    // First segment: target not editable → backlogged.
    setTargetState("not_editable");
    strategy.handleInterimSegment("alpha");
    await firstSegmentBacklogged.promise;
    expect(backlog).toEqual(["alpha"]);

    // Second segment: target editable again but the combined drain fails.
    setTargetState("editable");
    drainDictationBacklogMock.mockResolvedValueOnce({
      delivered: false,
      copiedToClipboard: false,
    });
    strategy.handleInterimSegment("beta");
    await secondSegmentBacklogged.promise;

    // The failed delivery must not silently drop the newer segment.
    expect(backlog).toEqual(["alpha", "beta"]);
  });

  it("updates transcript to reviewed text when output routing returns edited text", async () => {
    const strategy = new DictationStrategy();
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "original text",
      warnings: [],
      metadata: {},
    } as never);
    routeTranscriptOutputMock.mockResolvedValueOnce({
      delivered: true,
      remote: false,
      deliveredText: "edited text",
    });

    const result = await strategy.handleTranscript({
      rawTranscript: "original text",
      toneId: null,
      currentApp: null,
    } as never);

    expect(result.transcript).toBe("edited text");
    expect(result.sanitizedTranscript).toBe("original text");
  });

  it("shows the classified reason and no provider text when a model is retired", async () => {
    // The provider message for a retired Groq model names the model id, both
    // models in the chain, and both provider causes. It is diagnostic text and
    // it stays in the log. What the user reads is the fixed category the
    // classifier derives from it, so no provider-controlled string and no
    // model id is ever rendered in the interface.
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "fallback raw text",
      warnings: [POST_PROCESS_ERROR_CATEGORY.provider],
      metadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.provider,
      },
    });

    const { showToast } = await import("../actions/toast.actions");

    await new DictationStrategy().handleTranscript({
      rawTranscript: "fallback raw text",
      toneId: "custom-tone",
      currentApp: null,
    } as never);

    const toast = toastCall<{ message: string }>(vi.mocked(showToast));
    expect(toast.message).toBe(
      "Styling failed: Provider error. The raw transcript is saved in History.",
    );
    expect(toast.message).not.toContain("gpt-oss");
    expect(toast.message).not.toContain("{reason}");
  });

  it("falls back to a fixed reason when the failure carried no category", async () => {
    // A failure that never reached `recordPostProcessFailure` leaves the field
    // null. The toast must still render a complete sentence rather than
    // printing an empty reason or a leftover placeholder.
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "fallback raw text",
      warnings: [],
      metadata: { postProcessFailed: true, postProcessError: null },
    });

    const { showToast } = await import("../actions/toast.actions");

    await new DictationStrategy().handleTranscript({
      rawTranscript: "fallback raw text",
      toneId: "custom-tone",
      currentApp: null,
    } as never);

    expect(toastCall<{ message: string }>(vi.mocked(showToast)).message).toBe(
      "Styling failed: Provider error. The raw transcript is saved in History.",
    );
  });

  it("blocks insertion and shows error toast when post-processing fails", async () => {
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "fallback raw text",
      warnings: [POST_PROCESS_ERROR_CATEGORY.quotaOrPayment],
      metadata: {
        postProcessFailed: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });

    const { showToast } = await import("../actions/toast.actions");

    const strategy = new DictationStrategy();
    const result = await strategy.handleTranscript({
      rawTranscript: "fallback raw text",
      toneId: "custom-tone",
      currentApp: null,
    } as never);

    // Insertion is blocked: routeTranscriptOutput is NOT called
    expect(routeTranscriptOutputMock).not.toHaveBeenCalled();
    // Toast notification is shown
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Styling failed"),
        toastType: "error",
      }),
    );
    // Transcript is preserved for storage in history
    expect(result.transcript).toBe("fallback raw text");
    expect(result.postProcessMetadata.postProcessFailed).toBe(true);
  });

  it("blocks insertion when a provider edit batch is partial", async () => {
    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "complete raw transcript",
      warnings: [
        "Applied 1 of 2 post-processing edits; 1 could not be applied",
      ],
      metadata: {
        postProcessFailed: false,
        postProcessFallback: true,
        postProcessEditFailed: true,
        postProcessEditFailureCount: 1,
      },
    });
    const { showToast } = await import("../actions/toast.actions");

    const result = await new DictationStrategy().handleTranscript({
      rawTranscript: "complete raw transcript",
      toneId: "custom-tone",
      currentApp: null,
    } as never);

    expect(routeTranscriptOutputMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Styling was discarded because not all requested edits could be applied. The complete raw transcript is saved in History.",
        toastType: "error",
        action: "open_transcriptions",
      }),
    );
    expect(result.transcript).toBe("complete raw transcript");
    expect(result.postProcessMetadata.postProcessEditFailed).toBe(true);
  });

  it("does not promise a History row when persistence is suppressed", async () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.userPrefs = {
      ...createDefaultPreferences(),
      userId: LOCAL_USER_ID,
      incognitoModeEnabled: true,
    };
    setAppState(state, true);

    const { postProcessTranscript } =
      await import("../actions/transcribe.actions");
    vi.mocked(postProcessTranscript).mockResolvedValueOnce({
      transcript: "complete raw transcript",
      warnings: [
        "Applied 1 of 2 post-processing edits; 1 could not be applied",
      ],
      metadata: {
        postProcessFailed: false,
        postProcessFallback: true,
        postProcessEditFailed: true,
        postProcessEditFailureCount: 1,
      },
    });
    const { showToast } = await import("../actions/toast.actions");

    await new DictationStrategy().handleTranscript({
      rawTranscript: "complete raw transcript",
      toneId: "custom-tone",
      currentApp: null,
    } as never);

    // Incognito suppresses both store paths, so the row the persisted copy
    // promises does not exist, and the open-History action is dropped with it.
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Not all requested styling edits could be applied, so the styling was discarded. History is unavailable in this session, so the raw transcript was not saved.",
        toastType: "error",
        action: undefined,
      }),
    );
    expect(routeTranscriptOutputMock).not.toHaveBeenCalled();
  });

  it("drops in-flight interim paste work when cleanup runs while target probe is pending", async () => {
    const strategy = new DictationStrategy();
    const probeStarted = deferred<void>();
    const probeGate = deferred<"editable">();

    invokeMock.mockImplementation((command: string) => {
      if (command === "check_focused_paste_target") {
        probeStarted.resolve();
        return probeGate.promise;
      }
      return Promise.resolve(undefined);
    });

    strategy.handleInterimSegment("stale-interim-text");
    await probeStarted.promise;

    // Cleanup runs while probe is still waiting!
    await strategy.cleanup();

    // Now resolve the probe
    probeGate.resolve("editable");

    // Wait microtasks to let any queued work run
    await new Promise((r) => setTimeout(r, 10));

    // Must NOT have called routeTranscriptOutput or appendToDictationBacklog
    expect(routeTranscriptOutputMock).not.toHaveBeenCalled();
    expect(appendToDictationBacklogMock).not.toHaveBeenCalled();
  });
});

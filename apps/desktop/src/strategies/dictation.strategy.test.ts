import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPreferences } from "../actions/user.actions";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
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
  routeTranscriptOutputMock: vi.fn(
    async (args: {
      text: string;
      onReviewOpen?: (editedText: string) => Promise<boolean>;
    }) => ({
      delivered: true,
      remote: false,
      deliveredText: args.text.length > 0 ? args.text : null,
    }),
  ),
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

  it("persists the edited review text before completing an Open action", async () => {
    const persistReviewedTranscript = vi.fn().mockResolvedValue(true);
    routeTranscriptOutputMock.mockImplementationOnce(async (args) => {
      const persisted = await args.onReviewOpen?.("edited in the pill");
      return persisted
        ? {
            delivered: false,
            remote: false,
            deliveredText: null,
            reviewOpened: true,
            reviewedText: "edited in the pill",
          }
        : { delivered: false, remote: false, deliveredText: null };
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
      historyPersisted: true,
    });
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
      warnings: ["402 payment required"],
      metadata: {
        postProcessFailed: true,
        postProcessError: "402 payment required",
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
        message: "Styling failed. The raw transcript is saved in History.",
        toastType: "error",
      }),
    );
    expect(result).toMatchObject({
      transcript: "fallback raw text",
      postProcessMetadata: {
        postProcessFailed: true,
        postProcessError: "402 payment required",
      },
    });
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
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
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
  routeTranscriptOutputMock: vi.fn(async () => ({
    delivered: true,
    remote: false,
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
vi.mock("../actions/toast.actions", () => ({ showToast: vi.fn() }));
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
    userId: LOCAL_USER_ID,
    realtimeOutputEnabled: true,
    spokenCommandsEnabled: true,
    hallucinationFilterEnabled: false,
  } as never;
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

// Waits until the strategy's internal queue settles by polling the mock
// activity instead of reaching into private fields.
const settle = async () => {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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
    let resolveTarget: (value: { id: string } | null) => void = () => {};
    const targetGate = new Promise<{ id: string } | null>((resolve) => {
      resolveTarget = resolve;
    });
    const { tryRegisterCurrentAppTarget } =
      await import("../actions/app-target.actions");
    vi.mocked(tryRegisterCurrentAppTarget).mockReturnValueOnce(
      targetGate as never,
    );

    const strategy = new DictationStrategy();
    let settled = false;
    const startPromise = strategy.onBeforeStart().then(() => {
      settled = true;
    });

    await settle();
    expect(settled).toBe(false);
    expect(clearDictationBacklogMock).toHaveBeenCalledTimes(1);
    expect(incrementDictationBacklogNonceMock).toHaveBeenCalledTimes(1);

    resolveTarget({ id: "app-1" });
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
    setTargetState("not_editable");
    appendToDictationBacklogMock.mockImplementationOnce(() => {
      throw new Error("store blew up");
    });

    strategy.handleInterimSegment("first");
    await settle();

    setTargetState("editable");
    hasDictationBacklogMock.mockReturnValue(false);
    strategy.handleInterimSegment("second");
    await settle();

    expect(routeTranscriptOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second " }),
    );
  });

  it("serializes the finalize drain with a polled drain (no double delivery)", async () => {
    const strategy = new DictationStrategy();

    // One segment lands in the backlog.
    setTargetState("not_editable");
    strategy.handleInterimSegment("hello");
    await settle();
    expect(appendToDictationBacklogMock).toHaveBeenCalledTimes(1);

    // The finalize drain blocks mid-delivery; a poll that fired during it
    // must not start a second concurrent drain of the same snapshot.
    let backlog = true;
    hasDictationBacklogMock.mockImplementation(() => backlog);
    const releases: Array<
      (value: { delivered: boolean; copiedToClipboard: boolean }) => void
    > = [];
    drainDictationBacklogMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push((value) => {
            backlog = false;
            resolve(value);
          });
        }),
    );
    setTargetState("editable");

    const finalized = strategy.handleTranscript({
      rawTranscript: "hello",
      toneId: null,
      currentApp: null,
    } as never);
    await settle();
    const polled = strategy.checkAndDrainBacklog();
    await settle();

    for (const release of releases) {
      release({ delivered: true, copiedToClipboard: false });
    }
    await finalized;
    await polled;

    expect(drainDictationBacklogMock).toHaveBeenCalledTimes(1);
  });

  it("re-backlogs the new segment when the combined drain fails", async () => {
    const strategy = new DictationStrategy();

    let backlog: string[] = [];
    appendToDictationBacklogMock.mockImplementation((text: string) => {
      backlog.push(text);
    });
    hasDictationBacklogMock.mockImplementation(() => backlog.length > 0);

    // First segment: target not editable → backlogged.
    setTargetState("not_editable");
    strategy.handleInterimSegment("alpha");
    await settle();
    expect(backlog).toEqual(["alpha"]);

    // Second segment: target editable again but the combined drain fails.
    setTargetState("editable");
    drainDictationBacklogMock.mockResolvedValueOnce({
      delivered: false,
      copiedToClipboard: false,
    });
    strategy.handleInterimSegment("beta");
    await settle();

    // The failed delivery must not silently drop the newer segment.
    expect(backlog).toEqual(["alpha", "beta"]);
  });
});

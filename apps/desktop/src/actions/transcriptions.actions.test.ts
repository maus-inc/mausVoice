import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { RETRANSCRIPTION_SUCCESS_VISIBLE_MS } from "../state/transcriptions.state";
import { createDefaultPreferences } from "./user.actions";
import { getAppState, produceAppState, setAppState } from "../store";

const {
  loadTranscriptionAudio,
  updateTranscription,
  transcribeAudio,
  postProcessTranscript,
  showSnackbar,
  showErrorSnackbar,
  showPersistentToast,
  showCompletionToast,
  dismissToast,
} = vi.hoisted(() => ({
  loadTranscriptionAudio: vi.fn(),
  updateTranscription: vi.fn(),
  transcribeAudio: vi.fn(),
  postProcessTranscript: vi.fn(),
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
  showPersistentToast: vi.fn(async () => {}),
  showCompletionToast: vi.fn(async () => {}),
  dismissToast: vi.fn(async () => {}),
}));

vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({
    loadTranscriptionAudio,
    updateTranscription,
  }),
}));

vi.mock("./transcribe.actions", () => ({
  transcribeAudio,
  postProcessTranscript,
  storeTranscription: vi.fn(),
}));

vi.mock("./app.actions", () => ({
  showSnackbar,
  showErrorSnackbar,
}));

vi.mock("./toast.actions", async () => ({
  runToast: (await import("../../test/helpers/toast-mock")).runToastMock,
  showPersistentToast,
  showCompletionToast,
  dismissToast,
  showToast: vi.fn(async () => {}),
}));

// Spread the real module so helpers like detectLocale (pulled in through
// user.utils) keep working; stubbing only getIntl made the whole success
// path throw and silently skip the completion toast.
vi.mock("../i18n/intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../i18n/intl")>()),
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));

const { retranscribeTranscription, openRetranscribeDialog } =
  await import("./transcriptions.actions");
const { POST_PROCESS_TRUNCATED_WARNING } =
  await import("../utils/prompt.utils");

/** A run that never settles, so it stays in flight for the whole test. */
const neverSettles = () => new Promise<never>(() => undefined);

/** Start a run whose rejection is irrelevant to the assertion under test. */
const startIgnoredRun = (transcriptionId: string): void => {
  retranscribeTranscription({ transcriptionId }).catch(() => undefined);
};

const sampleTranscription = (id: string): Transcription => ({
  id,
  createdAt: "2026-08-01T00:00:00.000Z",
  createdByUserId: "user-1",
  transcript: "hello",
  isDeleted: false,
  audio: { filePath: `/tmp/${id}.wav`, durationMs: 1000 },
});

const seedTranscription = (id: string) => {
  produceAppState((draft) => {
    draft.transcriptionById[id] = sampleTranscription(id);
    draft.transcriptions.transcriptionIds = [
      id,
      ...draft.transcriptions.transcriptionIds.filter(
        (existing) => existing !== id,
      ),
    ];
  });
};

const mockSuccessfulPipeline = () => {
  loadTranscriptionAudio.mockResolvedValue({
    samples: [0, 1],
    sampleRate: 16000,
  });
  transcribeAudio.mockResolvedValue({
    rawTranscript: "hello",
    sanitizedTranscript: "hello",
    warnings: [],
    metadata: {},
  });
  postProcessTranscript.mockResolvedValue({
    transcript: "Hello there",
    warnings: [],
    metadata: {},
  });
  updateTranscription.mockImplementation(
    async (transcription: Transcription) => transcription,
  );
  // vi.clearAllMocks() strips implementations, so these must be restored or
  // the toast helpers return undefined and their .then() chains reject.
  showPersistentToast.mockResolvedValue();
  showCompletionToast.mockResolvedValue();
  dismissToast.mockResolvedValue();
};

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

describe("retranscribeTranscription feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetState();
    mockSuccessfulPipeline();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetState();
  });

  it("marks a row in-flight, then success, then clears the check", async () => {
    seedTranscription("a");

    const done = retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });
    expect(getAppState().transcriptions.retranscribingIds).toEqual(["a"]);
    expect(showSnackbar).toHaveBeenCalledWith("Retranscribing audio clip", {
      duration: 2 * 60 * 1000,
    });
    expect(showPersistentToast).toHaveBeenCalledWith(
      "Retranscribing audio clip",
      2 * 60 * 1000,
    );

    await done;

    expect(getAppState().transcriptions.retranscribingIds).toEqual([]);
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "a",
    ]);
    expect(showSnackbar).toHaveBeenCalledWith("Retranscription complete", {
      mode: "success",
    });
    expect(showCompletionToast).toHaveBeenCalledWith(
      "Retranscription complete",
    );

    await vi.advanceTimersByTimeAsync(RETRANSCRIPTION_SUCCESS_VISIBLE_MS);
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
  });

  it("recovers cleanly on error so the row is enabled again", async () => {
    seedTranscription("a");
    loadTranscriptionAudio.mockRejectedValue(new Error("no audio"));

    await retranscribeTranscription({ transcriptionId: "a" });

    expect(getAppState().transcriptions.retranscribingIds).toEqual([]);
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(showErrorSnackbar).toHaveBeenCalledWith("no audio");
    expect(dismissToast).toHaveBeenCalled();
    expect(showCompletionToast).not.toHaveBeenCalled();
  });

  it("ignores a second submit for a row that is already in flight", async () => {
    seedTranscription("a");
    let release:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    loadTranscriptionAudio.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });
    const second = retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });
    await second;

    expect(loadTranscriptionAudio).toHaveBeenCalledTimes(1);
    expect(getAppState().transcriptions.retranscribingIds).toEqual(["a"]);

    release?.({ samples: [0], sampleRate: 16000 });
    await first;
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "a",
    ]);
  });

  it("does not let one row's success timer clear another row or a newer run", async () => {
    seedTranscription("a");
    seedTranscription("b");

    let releaseA:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    let releaseB:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    loadTranscriptionAudio.mockImplementation((id: string) => {
      return new Promise((resolve) => {
        if (id === "a") releaseA = resolve;
        if (id === "b") releaseB = resolve;
      });
    });

    const runA = retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });
    const runB = retranscribeTranscription({
      transcriptionId: "b",
      languageCode: "en",
    });
    expect(getAppState().transcriptions.retranscribingIds).toEqual(["a", "b"]);
    expect(showPersistentToast).toHaveBeenCalledTimes(1);

    releaseA?.({ samples: [0], sampleRate: 16000 });
    await runA;
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "a",
    ]);
    expect(getAppState().transcriptions.retranscribingIds).toEqual(["b"]);
    expect(showCompletionToast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RETRANSCRIPTION_SUCCESS_VISIBLE_MS);
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(getAppState().transcriptions.retranscribingIds).toEqual(["b"]);

    releaseB?.({ samples: [0], sampleRate: 16000 });
    await runB;
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "b",
    ]);
    expect(showCompletionToast).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale success timer wipe a newer success on the same row", async () => {
    seedTranscription("a");

    await retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "a",
    ]);

    await retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "a",
    ]);

    await vi.advanceTimersByTimeAsync(RETRANSCRIPTION_SUCCESS_VISIBLE_MS - 1);
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "a",
    ]);

    await vi.advanceTimersByTimeAsync(1);
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
  });

  it("does not open the dialog for a row that is already retranscribing", () => {
    produceAppState((draft) => {
      draft.transcriptions.retranscribingIds.push("a");
    });

    openRetranscribeDialog("a");
    expect(getAppState().transcriptions.retranscribeDialogOpen).toBe(false);

    openRetranscribeDialog("b");
    expect(getAppState().transcriptions.retranscribeDialogOpen).toBe(true);
    expect(getAppState().transcriptions.retranscribeDialogTranscriptionId).toBe(
      "b",
    );
  });

  it("persists fresh durations and post-process model instead of stale ones", async () => {
    produceAppState((draft) => {
      draft.transcriptionById["a"] = {
        ...sampleTranscription("a"),
        transcriptionDurationMs: 99_000,
        postprocessDurationMs: 88_000,
        postProcessModel: "old-model",
      };
      draft.transcriptions.transcriptionIds = ["a"];
    });

    transcribeAudio.mockResolvedValue({
      rawTranscript: "hello",
      sanitizedTranscript: "hello",
      warnings: [],
      metadata: { transcriptionDurationMs: 120 },
    });
    postProcessTranscript.mockResolvedValue({
      transcript: "Hello there",
      warnings: [],
      metadata: {
        postprocessDurationMs: 45,
        postProcessModel: "openai/gpt-oss-20b",
      },
    });

    await retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionDurationMs: 120,
        postprocessDurationMs: 45,
        postProcessModel: "openai/gpt-oss-20b",
      }),
    );
  });

  it("clears stale durations when the new run reports none", async () => {
    produceAppState((draft) => {
      draft.transcriptionById["a"] = {
        ...sampleTranscription("a"),
        transcriptionDurationMs: 99_000,
        postprocessDurationMs: 88_000,
      };
      draft.transcriptions.transcriptionIds = ["a"];
    });

    await retranscribeTranscription({
      transcriptionId: "a",
      languageCode: "en",
    });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionDurationMs: null,
        postprocessDurationMs: null,
        postProcessModel: null,
      }),
    );
  });

  it("replaces the loading toast with the completion toast on success", async () => {
    seedTranscription("a");

    await retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);

    // The long-lived loading toast must be dismissed, not left to expire.
    expect(dismissToast).toHaveBeenCalledTimes(1);
    expect(showCompletionToast).toHaveBeenCalledWith(
      "Retranscription complete",
    );
  });

  it("still shows the completion toast when the dismiss fails", async () => {
    seedTranscription("a");
    // A failed dismiss round trip must not suppress the finished state.
    vi.mocked(dismissToast).mockRejectedValueOnce(new Error("pill offline"));

    await retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);

    expect(showCompletionToast).toHaveBeenCalledWith(
      "Retranscription complete",
    );
  });

  it("releases toast ownership after success so a stale run sends no dismiss", async () => {
    seedTranscription("a");

    let release:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    loadTranscriptionAudio.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const stale = retranscribeTranscription({ transcriptionId: "a" });

    // A newer run for the same row completes first and owns the toast.
    produceAppState((draft) => {
      draft.transcriptions.retranscribingIds = [];
    });
    await retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);
    dismissToast.mockClear();

    // The superseded run now settles. Success already released ownership, so
    // it must not fire another dismiss at the native pill.
    release?.({ samples: [0], sampleRate: 16000 });
    await stale;
    await vi.advanceTimersByTimeAsync(0);

    expect(dismissToast).not.toHaveBeenCalled();
  });

  it("leaves the newer run's state intact when a superseded run settles", async () => {
    seedTranscription("a");

    let releaseStale:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    let releaseNewer:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    loadTranscriptionAudio
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseStale = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseNewer = resolve;
        }),
      );

    const stale = retranscribeTranscription({ transcriptionId: "a" });
    produceAppState((draft) => {
      draft.transcriptions.retranscribingIds = [];
    });
    const newer = retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);

    // The superseded run settles while the newer run is still working. It must
    // not clear the newer run's in-flight marker, or the row would look idle
    // while a retranscription is genuinely still running.
    releaseStale?.({ samples: [0], sampleRate: 16000 });
    await stale;
    await vi.advanceTimersByTimeAsync(0);

    expect(getAppState().transcriptions.retranscribingIds).toContain("a");

    // The newer run still finishes normally and frees the row for reuse.
    releaseNewer?.({ samples: [0], sampleRate: 16000 });
    await newer;
    await vi.advanceTimersByTimeAsync(RETRANSCRIPTION_SUCCESS_VISIBLE_MS);

    expect(getAppState().transcriptions.retranscribingIds).not.toContain("a");
  });

  it("does not double-dismiss when a later run fails after a success", async () => {
    seedTranscription("a");
    await retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);
    dismissToast.mockClear();

    loadTranscriptionAudio.mockRejectedValueOnce(new Error("no audio"));
    await retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);

    // Exactly one dismiss for the failing run's own loading toast.
    expect(dismissToast).toHaveBeenCalledTimes(1);
  });

  it("dismisses the orphaned loading toast when a superseded run is the last in flight", async () => {
    seedTranscription("a");

    let release:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    loadTranscriptionAudio.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const stale = retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);

    // A newer generation supersedes the first run but never finishes, so no
    // success path ever runs and nothing else can clear the loading toast.
    produceAppState((draft) => {
      draft.transcriptions.retranscribingIds = [];
    });
    loadTranscriptionAudio.mockReturnValueOnce(neverSettles());
    startIgnoredRun("a");
    await vi.advanceTimersByTimeAsync(0);
    produceAppState((draft) => {
      draft.transcriptions.retranscribingIds = [];
    });
    dismissToast.mockClear();
    showCompletionToast.mockClear();

    // The superseded run settles with nothing left in flight. It still owns the
    // long-lived loading toast, so it must dismiss it rather than return early.
    release?.({ samples: [0], sampleRate: 16000 });
    await stale;
    await vi.advanceTimersByTimeAsync(0);

    expect(dismissToast).toHaveBeenCalledTimes(1);
    expect(showCompletionToast).not.toHaveBeenCalled();
  });

  it("does not let a stale completion toast replace newer loading feedback", async () => {
    seedTranscription("a");
    seedTranscription("b");

    // Hold the dismiss round trip open so a newer batch can start first.
    let releaseDismiss: (() => void) | undefined;
    dismissToast.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDismiss = () => resolve();
        }),
    );

    await retranscribeTranscription({ transcriptionId: "a" });
    await vi.advanceTimersByTimeAsync(0);

    // A newer run starts and shows its own loading toast while the previous
    // run's dismiss is still pending. It hangs, so it never completes itself.
    loadTranscriptionAudio.mockReturnValueOnce(neverSettles());
    startIgnoredRun("b");
    await vi.advanceTimersByTimeAsync(0);
    showCompletionToast.mockClear();

    // The earlier dismiss resolves last. Its completion toast is stale now and
    // must not overwrite the newer run's loading toast.
    releaseDismiss?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(showCompletionToast).not.toHaveBeenCalled();
  });
});

describe("retranscribeTranscription persistence gate", () => {
  const seedGated = (ephemeralSessionActive: boolean) => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.userPrefs = createDefaultPreferences();
    state.local.ephemeralSessionActive = ephemeralSessionActive;
    const transcription = sampleTranscription("tx-gate");
    transcription.transcript = "original text";
    state.transcriptionById["tx-gate"] = transcription;
    setAppState(state, true);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadTranscriptionAudio.mockResolvedValue({
      samples: [0.1, 0.2],
      sampleRate: 16000,
    });
    updateTranscription.mockImplementation(
      async (payload: Transcription) => payload,
    );
    transcribeAudio.mockResolvedValue({
      rawTranscript: "raw retranscribed",
      sanitizedTranscript: "raw retranscribed",
      warnings: [],
      metadata: {},
    });
    postProcessTranscript.mockResolvedValue({
      transcript: "retranscribed text",
      warnings: [],
      metadata: {},
    });
  });

  afterEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("persists the retranscribed payload when persistence is allowed", async () => {
    seedGated(false);

    await retranscribeTranscription({ transcriptionId: "tx-gate" });

    expect(updateTranscription).toHaveBeenCalledTimes(1);
    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tx-gate",
        transcript: "retranscribed text",
      }),
    );
    expect(getAppState().transcriptionById["tx-gate"]?.transcript).toBe(
      "retranscribed text",
    );
  });

  it("updates memory only and skips the repo write during an ephemeral session", async () => {
    seedGated(true);

    await retranscribeTranscription({ transcriptionId: "tx-gate" });

    expect(updateTranscription).not.toHaveBeenCalled();
    expect(getAppState().transcriptionById["tx-gate"]?.transcript).toBe(
      "retranscribed text",
    );
  });
});

describe("retranscribeTranscription unstyled post-processing", () => {
  const POLISHED = "Polished summary of the call.";
  const RAW_ASR = "raw asr from this run";

  const seedStyledRow = (id: string, transcript: string) => {
    produceAppState((draft) => {
      draft.transcriptionById[id] = {
        ...sampleTranscription(id),
        transcript,
      };
      draft.transcriptions.transcriptionIds = [id];
    });
  };

  const mockUnstyledPostProcess = (
    metadata: Record<string, unknown>,
    warnings: string[] = [],
  ) => {
    transcribeAudio.mockResolvedValue({
      rawTranscript: RAW_ASR,
      sanitizedTranscript: RAW_ASR,
      warnings: [],
      metadata: {},
    });
    postProcessTranscript.mockResolvedValue({
      // The pipeline hands back the raw ASR whenever styling did not land.
      transcript: RAW_ASR,
      warnings,
      metadata,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    mockSuccessfulPipeline();
    loadTranscriptionAudio.mockResolvedValue({
      samples: [0.1, 0.2],
      sampleRate: 16000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("keeps the polished transcript when the post-processing request failed", async () => {
    seedStyledRow("unstyled", POLISHED);
    mockUnstyledPostProcess({
      postProcessFailed: true,
      postProcessError: "Quota or payment required (402)",
    });

    await retranscribeTranscription({ transcriptionId: "unstyled" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        // The text already on the row is worth more than raw ASR, so it stays.
        transcript: POLISHED,
        rawTranscript: RAW_ASR,
        postProcessDegraded: true,
        postProcessFailed: true,
      }),
    );
    expect(getAppState().transcriptionById["unstyled"]?.transcript).toBe(
      POLISHED,
    );
    // The run failed, so the row must not show a success check or completion
    // toast, and the recorded failure category is what the user is shown.
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(showCompletionToast).not.toHaveBeenCalled();
    expect(showErrorSnackbar).toHaveBeenCalledWith(
      "Quota or payment required (402)",
    );
  });

  it("keeps the polished transcript when the response was cut off", async () => {
    seedStyledRow("truncated", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessDegraded: true },
      [POST_PROCESS_TRUNCATED_WARNING],
    );

    await retranscribeTranscription({ transcriptionId: "truncated" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: POLISHED,
        rawTranscript: RAW_ASR,
        postProcessDegraded: true,
        // The provider answered, so the failure sentinel must stay false.
        postProcessFailed: false,
      }),
    );
    expect(showErrorSnackbar).toHaveBeenCalledWith(
      POST_PROCESS_TRUNCATED_WARNING,
    );
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(showCompletionToast).not.toHaveBeenCalled();

    // A failed run must free the row: the generation counter is released on
    // this path, so a second run starts clean instead of being read as stale.
    mockSuccessfulPipeline();
    await retranscribeTranscription({ transcriptionId: "truncated" });
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "truncated",
    ]);
    expect(showErrorSnackbar).toHaveBeenCalledTimes(1);
  });

  it("falls back to the new raw ASR when the row was never styled", async () => {
    seedStyledRow("unstyled-empty", "");
    mockUnstyledPostProcess({ postProcessDegraded: true });

    await retranscribeTranscription({ transcriptionId: "unstyled-empty" });

    // There is no polished text to protect, so the raw ASR is strictly better
    // than leaving the row empty.
    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: RAW_ASR,
        rawTranscript: RAW_ASR,
        postProcessDegraded: true,
      }),
    );
    expect(showErrorSnackbar).toHaveBeenCalledWith(
      POST_PROCESS_TRUNCATED_WARNING,
    );
  });

  it("replaces the transcript and reports success when styling worked", async () => {
    seedStyledRow("styled", POLISHED);
    postProcessTranscript.mockResolvedValue({
      transcript: "Freshly styled summary.",
      warnings: [],
      metadata: { postProcessFailed: false, postProcessDegraded: false },
    });

    await retranscribeTranscription({ transcriptionId: "styled" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "Freshly styled summary.",
        postProcessDegraded: false,
      }),
    );
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "styled",
    ]);
    expect(showCompletionToast).toHaveBeenCalledWith(
      "Retranscription complete",
    );
    expect(showErrorSnackbar).not.toHaveBeenCalled();
  });
});

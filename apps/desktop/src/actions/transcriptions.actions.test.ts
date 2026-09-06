import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { RETRANSCRIPTION_SUCCESS_VISIBLE_MS } from "../state/transcriptions.state";
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

vi.mock("./toast.actions", () => ({
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
});

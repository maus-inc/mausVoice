import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "@maus-inc/types";
import type { IntlShape } from "react-intl";
import { INITIAL_APP_STATE } from "../state/app.state";
import { RETRANSCRIPTION_SUCCESS_VISIBLE_MS } from "../state/transcriptions.state";
import type { PostProcessMetadata } from "./transcribe.actions";
import { createDefaultPreferences } from "./user.actions";
import { getAppState, produceAppState, setAppState } from "../store";

const {
  loadTranscriptionAudio,
  importAudioFile: importAudioFileMock,
  updateTranscription,
  storeTranscription: storeTranscriptionMock,
  transcribeAudio,
  postProcessTranscript,
  generateText,
  showSnackbar,
  showErrorSnackbar,
  showPersistentToast,
  showCompletionToast,
  dismissToast,
} = vi.hoisted(() => ({
  loadTranscriptionAudio: vi.fn(),
  importAudioFile: vi.fn(),
  updateTranscription: vi.fn(),
  storeTranscription: vi.fn(),
  transcribeAudio: vi.fn(),
  postProcessTranscript: vi.fn(),
  generateText: vi.fn(),
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
  showPersistentToast: vi.fn(() => Promise.resolve()),
  showCompletionToast: vi.fn(() => Promise.resolve()),
  dismissToast: vi.fn(() => Promise.resolve()),
}));

vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({
    loadTranscriptionAudio,
    importAudioFile: importAudioFileMock,
    updateTranscription,
  }),
  // Only the unparseable-response test below reaches the real post-processing
  // step, and it does so to produce genuine metadata for a provider answer.
  getGenerateTextRepo: () => ({
    repo: { generateText, streamChat: vi.fn() },
    apiKeyId: "test-key",
    provider: "test-provider",
    warnings: [],
  }),
}));

vi.mock("./transcribe.actions", () => ({
  transcribeAudio,
  postProcessTranscript,
  storeTranscription: storeTranscriptionMock,
}));

vi.mock("./app.actions", () => ({
  showSnackbar,
  showErrorSnackbar,
}));

// Only the unparseable-response test below builds a real post-processing
// request, and an empty app state carries no tone for it to resolve. Every
// other test here uses the mocked post-processing step.
// Partial, not wholesale: `fast-style.utils` reads the tone id constants at
// module load, so replacing the module outright left them undefined. Only the
// two lookups this file needs to control are stubbed.
vi.mock("../utils/tone.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/tone.utils")>()),
  getToneById: () => null,
  getToneConfig: () => ({ name: "Default", prompt: "" }),
}));

vi.mock("./toast.actions", async () => ({
  runToast: (await import("../../test/helpers/toast-mock")).runToastMock,
  showPersistentToast,
  showCompletionToast,
  dismissToast,
  showToast: vi.fn(() => Promise.resolve()),
}));

const { intlFormatMessage } = vi.hoisted(() => ({
  /** Every descriptor the code under test asked the intl layer to format. */
  intlFormatMessage: vi.fn(),
}));

// The intl module is wrapped, never stubbed. `getIntl` short-circuits a
// descriptor with no `id` to its `defaultMessage` and only then delegates, so
// the string a formatted descriptor returns is the same string the source
// hardcodes. Output alone cannot tell a routed message from a copied one; the
// wrapper records the descriptors that were asked for and hands each one to
// the real formatter, so the copy on screen still travels the production path
// and a message that never reaches the intl layer cannot pass.
vi.mock("../i18n/intl", async () => {
  const actual =
    await vi.importActual<typeof import("../i18n/intl")>("../i18n/intl");
  return {
    ...actual,
    getIntl: (...args: Parameters<typeof actual.getIntl>) => {
      const intl = actual.getIntl(...args);
      const realFormatMessage = intl.formatMessage;
      return {
        ...intl,
        formatMessage: (...format: Parameters<IntlShape["formatMessage"]>) => {
          intlFormatMessage(format[0]);
          return realFormatMessage(...format);
        },
      };
    },
  };
});

const {
  importAudioFile,
  resumeInterruptedPostProcessEditRetries,
  retranscribeTranscription,
  openRetranscribeDialog,
} = await import("./transcriptions.actions");
const { POST_PROCESS_TRUNCATED_WARNING } =
  await import("../utils/prompt.utils");

/** A run that never settles, so it stays in flight for the whole test. */
const neverSettles = () => new Promise<never>(() => undefined);

/** Start a run whose rejection is irrelevant to the assertion under test. */
const startIgnoredRun = (transcriptionId: string): void => {
  retranscribeTranscription({ transcriptionId }).catch(() => undefined);
};

/**
 * Pin the jitter source to its maximum, which is one tick under the first cap.
 * The recovery pass draws its delay from the platform crypto generator rather
 * than `Math.random`, so this spy is what makes the wait deterministic.
 */
const pinJitterToMaximum = () =>
  vi
    .spyOn(globalThis.crypto, "getRandomValues")
    .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array) {
        array[0] = 0xffffffff;
      }
      return array;
    });

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
  updateTranscription.mockImplementation((transcription: Transcription) =>
    Promise.resolve(transcription),
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
    updateTranscription.mockImplementation((payload: Transcription) =>
      Promise.resolve(payload),
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
  /** The category `recordPostProcessFailure` records for a 402. */
  const QUOTA_CATEGORY = "Quota or payment required (402)";
  /**
   * The localized descriptor `postProcessErrorReason` resolves that category to.
   * The category itself is internal vocabulary: it carries the HTTP status and
   * would print in English in every locale.
   */
  const QUOTA_COPY = "Quota or payment required";
  /** The reason recorded for an answer that parsed but failed validation. */
  const VALIDATION_WARNING =
    "Post-processing response validation failed: result is required";
  /** Localized copy for a reply that ran out of the model's output budget. */
  const TRUNCATED_COPY =
    "The styling reply was cut off at the model's output limit, so the partial reply was discarded and the previous text was kept.";
  /** Localized copy for a reply that came back unreadable. */
  const UNREADABLE_COPY =
    "The styling reply could not be read, so it was discarded and the previous text was kept.";

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
    metadata: PostProcessMetadata,
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

  /** Every string the user was shown, joined for a substring check. */
  const shownToUser = () =>
    showErrorSnackbar.mock.calls.map(([message]) => String(message)).join(" ");

  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.clearAllMocks();
    resetState();
    mockSuccessfulPipeline();
    loadTranscriptionAudio.mockResolvedValue({
      samples: [0.1, 0.2],
      sampleRate: 16000,
    });
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.clearAllMocks();
    resetState();
  });

  it("keeps the polished transcript when the post-processing request failed", async () => {
    seedStyledRow("unstyled", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: true, postProcessError: QUOTA_CATEGORY },
      [QUOTA_CATEGORY],
    );

    await retranscribeTranscription({ transcriptionId: "unstyled" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        // The text already on the row is worth more than raw ASR, so it stays.
        transcript: POLISHED,
        rawTranscript: RAW_ASR,
        warnings: [QUOTA_CATEGORY],
        postProcessFailed: true,
      }),
    );
    expect(getAppState().transcriptionById["unstyled"]?.transcript).toBe(
      POLISHED,
    );
    // A failed request records the failure sentinel only. Nothing marks it as a
    // degraded answer too, because the two describe different failures and the
    // row must never claim both.
    expect(updateTranscription.mock.calls[0]?.[0]).toMatchObject({
      postProcessFallback: null,
    });
    // The run failed, so the row must not show a success check or completion
    // toast. The snackbar gets the localized descriptor for the recorded
    // category; the category itself stays in the log, because `showErrorSnackbar`
    // renders its argument verbatim and the category is internal vocabulary.
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(showCompletionToast).not.toHaveBeenCalled();
    expect(showErrorSnackbar).toHaveBeenCalledWith(QUOTA_COPY);
    expect(shownToUser()).not.toContain(QUOTA_CATEGORY);
    expect(intlFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMessage: QUOTA_COPY }),
    );
    expect(console.error).toHaveBeenCalledWith(
      "Failed to retranscribe audio",
      QUOTA_CATEGORY,
    );
  });

  it("keeps the polished transcript when the response was cut off", async () => {
    seedStyledRow("truncated", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [POST_PROCESS_TRUNCATED_WARNING],
    );

    await retranscribeTranscription({ transcriptionId: "truncated" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: POLISHED,
        rawTranscript: RAW_ASR,
        warnings: [POST_PROCESS_TRUNCATED_WARNING],
        // The provider answered, so the failure sentinel must stay false.
        postProcessFailed: false,
      }),
    );
    // The stored warning stays English because it lives on the row, but the
    // toast resolves a localized sentence for it and logs the raw reason.
    expect(showErrorSnackbar).toHaveBeenCalledWith(TRUNCATED_COPY);
    expect(showErrorSnackbar).not.toHaveBeenCalledWith(
      POST_PROCESS_TRUNCATED_WARNING,
    );
    expect(console.error).toHaveBeenCalledWith(
      "Failed to retranscribe audio",
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

  it("keeps the polished transcript when the provider response cannot be parsed", async () => {
    seedStyledRow("unparseable", POLISHED);
    generateText.mockResolvedValueOnce({
      // Cut inside a code fence: the missing closing backticks leave residue no
      // repair candidate can clear, so the parse throws instead of recovering a
      // truncated fragment. The metadata that comes back is the point of this
      // test, so the real post-processing step produces it.
      text: '```json\n{"result": "Hello there, this is a very long dictation that ke',
      metadata: { postProcessingMode: "api" },
    });
    const { postProcessTranscript: runPostProcessing } = await vi.importActual<
      typeof import("./transcribe.actions")
    >("./transcribe.actions");
    const unparsed = await runPostProcessing({
      rawTranscript: RAW_ASR,
      toneId: null,
    });
    mockUnstyledPostProcess(unparsed.metadata, unparsed.warnings);

    await retranscribeTranscription({ transcriptionId: "unparseable" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        // The polished text stays, and this run's raw ASR is the only record of
        // what was actually said.
        transcript: POLISHED,
        rawTranscript: RAW_ASR,
        // The request came back, so the failure sentinel stays false.
        postProcessFailed: false,
      }),
    );
    expect(getAppState().transcriptionById["unparseable"]?.transcript).toBe(
      POLISHED,
    );
    // Unusable styling is not a finished retranscription, so the row must not
    // report success. The toast names the outcome in localized copy, and the
    // parse error that explains it stays in the log instead of leaking through
    // a snackbar, Zod issue list and all.
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(showCompletionToast).not.toHaveBeenCalled();
    expect(showErrorSnackbar).toHaveBeenCalledWith(UNREADABLE_COPY);
    expect(shownToUser()).not.toContain("Could not parse or repair");
    expect(showErrorSnackbar).not.toHaveBeenCalledWith(unparsed.warnings[0]);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to retranscribe audio",
      unparsed.warnings[0],
    );
  });

  it("falls back to the new raw ASR when the row was never styled", async () => {
    seedStyledRow("unstyled-empty", "");
    // A response that parses but fails schema validation is unusable for a
    // different reason than a cut-off one, and it always records that reason.
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [VALIDATION_WARNING],
    );

    await retranscribeTranscription({ transcriptionId: "unstyled-empty" });

    // There is no polished text to protect, so the raw ASR is strictly better
    // than leaving the row empty.
    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: RAW_ASR,
        rawTranscript: RAW_ASR,
        warnings: [VALIDATION_WARNING],
        postProcessFailed: false,
      }),
    );
    // The recorded reason is not shown. The toast describes the outcome, and a
    // validation failure must not borrow the cut-off copy any more than the
    // raw schema issue list is shown.
    expect(showErrorSnackbar).toHaveBeenCalledWith(UNREADABLE_COPY);
    expect(showErrorSnackbar).not.toHaveBeenCalledWith(VALIDATION_WARNING);
    expect(shownToUser()).not.toContain("validation failed");
    expect(showErrorSnackbar).not.toHaveBeenCalledWith(
      POST_PROCESS_TRUNCATED_WARNING,
    );
    expect(console.error).toHaveBeenCalledWith(
      "Failed to retranscribe audio",
      VALIDATION_WARNING,
    );
  });

  it("routes the unstyled-run copy through the intl layer", async () => {
    seedStyledRow("localized", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [POST_PROCESS_TRUNCATED_WARNING],
    );

    await retranscribeTranscription({ transcriptionId: "localized" });

    // The descriptor is what the action asked the intl layer for, and the
    // wrapper only records what it was given, so this fails the moment the
    // action stops calling `getIntl` and inlines the sentence instead. The
    // sentence itself cannot carry that proof: the real helper returns the
    // `defaultMessage` of an id-less descriptor unchanged, so a formatted
    // sentence and a hardcoded one are the same string.
    expect(intlFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMessage: TRUNCATED_COPY }),
    );
    expect(showErrorSnackbar).toHaveBeenCalledWith(TRUNCATED_COPY);

    // The other unusable-answer branch, through the same layer.
    seedStyledRow("localized-unreadable", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [VALIDATION_WARNING],
    );

    await retranscribeTranscription({
      transcriptionId: "localized-unreadable",
    });

    expect(intlFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMessage: UNREADABLE_COPY }),
    );
    expect(showErrorSnackbar).toHaveBeenLastCalledWith(UNREADABLE_COPY);
  });

  it("tells a cut-off reply apart from an unreadable one", async () => {
    seedStyledRow("truncated-vs-unreadable", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [POST_PROCESS_TRUNCATED_WARNING],
    );

    await retranscribeTranscription({
      transcriptionId: "truncated-vs-unreadable",
    });

    seedStyledRow("unreadable", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [VALIDATION_WARNING],
    );

    await retranscribeTranscription({ transcriptionId: "unreadable" });

    const shown = showErrorSnackbar.mock.calls.map(([message]) =>
      String(message),
    );
    expect(shown).toEqual([TRUNCATED_COPY, UNREADABLE_COPY]);
  });

  it("replaces the transcript and reports success when styling worked", async () => {
    seedStyledRow("styled", POLISHED);
    postProcessTranscript.mockResolvedValue({
      transcript: "Freshly styled summary.",
      warnings: [],
      metadata: { postProcessFailed: false, postProcessFallback: false },
    });

    await retranscribeTranscription({ transcriptionId: "styled" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "Freshly styled summary.",
        postProcessFailed: false,
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

  it("keeps the locally styled text when the provider failed but the local style ran", async () => {
    // `postProcessFallback` marks two different runs, and only one of them left
    // the row without styling: a request that failed while the deterministic
    // local style produced real styled text. Reading the flag on its own threw
    // that text away and kept the row's previous text, even though this run's
    // text was the only polished answer available.
    class Cerebras402 extends Error {
      status = 402;
      constructor() {
        super("402 status code (no body)");
        this.name = "CerebrasProviderError";
      }
    }
    generateText.mockRejectedValueOnce(new Cerebras402());
    const { postProcessTranscript: runPostProcessing } = await vi.importActual<
      typeof import("./transcribe.actions")
    >("./transcribe.actions");
    const degraded = await runPostProcessing({
      rawTranscript: "um so I went to the store",
      toneId: "default",
    });
    // The metadata that comes back is the point of this test, so the real
    // post-processing step produces it rather than a hand-written stand-in.
    expect(degraded.metadata.postProcessFallback).toBe(true);
    expect(degraded.metadata.postProcessFailed).toBe(false);
    expect(degraded.metadata.postProcessError).toContain("402");
    expect(degraded.transcript.toLowerCase()).not.toContain("um");

    seedStyledRow("degraded", POLISHED);
    postProcessTranscript.mockResolvedValue(degraded);

    await retranscribeTranscription({ transcriptionId: "degraded" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: degraded.transcript,
        // Still recorded as a degraded run, so History can say the local style
        // was used instead of the provider.
        postProcessFallback: true,
        postProcessFailed: false,
      }),
    );
    expect(getAppState().transcriptionById["degraded"]?.transcript).toBe(
      degraded.transcript,
    );
    expect(showErrorSnackbar).not.toHaveBeenCalled();
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "degraded",
    ]);
  });

  it("retranscribes the same History row once after the third partial-edit failure", async () => {
    vi.useFakeTimers();
    const random = pinJitterToMaximum();
    try {
      const row = {
        ...sampleTranscription("partial-chain"),
        postProcessEditFailed: true,
        postProcessEditFailureCount: 2,
        postProcessEditAutoRetryUsed: null,
      };
      produceAppState((draft) => {
        draft.transcriptionById[row.id] = row;
        draft.transcriptions.transcriptionIds = [row.id];
      });
      transcribeAudio.mockResolvedValue({
        rawTranscript: RAW_ASR,
        sanitizedTranscript: RAW_ASR,
        warnings: [],
        metadata: {},
      });
      postProcessTranscript
        .mockResolvedValueOnce({
          transcript: RAW_ASR,
          warnings: ["one edit could not be applied"],
          metadata: {
            postProcessFailed: false,
            postProcessFallback: true,
            postProcessEditFailed: true,
            postProcessEditFailureCount: 3,
          },
        })
        .mockResolvedValueOnce({
          transcript: RAW_ASR,
          warnings: ["another edit could not be applied"],
          metadata: {
            postProcessFailed: false,
            postProcessFallback: true,
            postProcessEditFailed: true,
            postProcessEditFailureCount: 4,
          },
        });

      await retranscribeTranscription({
        transcriptionId: row.id,
        toneId: "custom-tone",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(updateTranscription).toHaveBeenCalledTimes(2);
      expect(getAppState().transcriptionById[row.id]).toMatchObject({
        postProcessEditFailureCount: 3,
        postProcessEditAutoRetryUsed: true,
      });

      // The pinned jitter maximum is 999ms, one tick under the one-second cap.
      // The automatic pass uses the same row id and therefore produces a third
      // repository update, not a new create call.
      await vi.advanceTimersByTimeAsync(998);
      expect(transcribeAudio).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transcribeAudio).toHaveBeenCalledTimes(2);
      expect(updateTranscription).toHaveBeenCalledTimes(3);
      expect(updateTranscription.mock.calls[2]?.[0]).toMatchObject({
        id: row.id,
        postProcessEditFailureCount: 4,
        postProcessEditAutoRetryUsed: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not let a manual retry race the automatic recovery pass", async () => {
    vi.useFakeTimers();
    const random = pinJitterToMaximum();
    try {
      const row = {
        ...sampleTranscription("automatic-ownership"),
        postProcessEditFailed: true,
        postProcessEditFailureCount: 2,
        postProcessEditAutoRetryUsed: null,
      };
      produceAppState((draft) => {
        draft.transcriptionById[row.id] = row;
        draft.transcriptions.transcriptionIds = [row.id];
      });
      transcribeAudio.mockResolvedValue({
        rawTranscript: RAW_ASR,
        sanitizedTranscript: RAW_ASR,
        warnings: [],
        metadata: {},
      });
      postProcessTranscript
        .mockResolvedValueOnce({
          transcript: RAW_ASR,
          warnings: ["one edit could not be applied"],
          metadata: {
            postProcessFailed: false,
            postProcessFallback: true,
            postProcessEditFailed: true,
            postProcessEditFailureCount: 3,
          },
        })
        .mockResolvedValueOnce({
          transcript: "Fully styled audio",
          warnings: [],
          metadata: { postProcessFailed: false },
        });

      await retranscribeTranscription({ transcriptionId: row.id });
      await retranscribeTranscription({ transcriptionId: row.id });

      expect(transcribeAudio).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(transcribeAudio).toHaveBeenCalledTimes(2);
      expect(updateTranscription).toHaveBeenCalledTimes(3);
      expect(updateTranscription.mock.calls[2]?.[0]).toMatchObject({
        id: row.id,
        transcript: "Fully styled audio",
      });
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("schedules imported-audio recovery after storing the durable row", async () => {
    vi.useFakeTimers();
    const random = pinJitterToMaximum();
    try {
      const row = {
        ...sampleTranscription("imported-partial"),
        postProcessEditFailed: true,
        postProcessEditFailureCount: 3,
        postProcessEditAutoRetryUsed: null,
      };
      produceAppState((draft) => {
        draft.transcriptionById[row.id] = row;
        draft.transcriptions.transcriptionIds = [row.id];
      });
      importAudioFileMock.mockResolvedValue({
        samples: [0.1, 0.2],
        sampleRate: 16000,
      });
      transcribeAudio.mockResolvedValue({
        rawTranscript: RAW_ASR,
        sanitizedTranscript: RAW_ASR,
        warnings: [],
        metadata: {},
      });
      postProcessTranscript.mockResolvedValue({
        transcript: RAW_ASR,
        warnings: ["one edit could not be applied"],
        metadata: {
          postProcessFailed: false,
          postProcessFallback: true,
          postProcessEditFailed: true,
          postProcessEditFailureCount: 3,
        },
      });
      storeTranscriptionMock.mockResolvedValue({
        transcription: row,
        wordCount: 4,
      });
      updateTranscription.mockImplementation((payload: Transcription) =>
        Promise.resolve(payload),
      );

      await expect(
        importAudioFile({ toneId: "custom-tone", languageCode: "en" }),
      ).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(storeTranscriptionMock).toHaveBeenCalledTimes(1);
      expect(updateTranscription).toHaveBeenCalledWith(
        expect.objectContaining({
          id: row.id,
          postProcessEditAutoRetryUsed: true,
        }),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(transcribeAudio).toHaveBeenCalledTimes(2);
      expect(storeTranscriptionMock).toHaveBeenCalledTimes(1);
      expect(updateTranscription).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("resumes the automatic pass a previous process claimed and never ran", async () => {
    vi.useFakeTimers();
    try {
      const row = {
        ...sampleTranscription("interrupted-claim"),
        postProcessEditFailed: true,
        postProcessEditFailureCount: 3,
        postProcessEditAutoRetryUsed: true,
      };
      produceAppState((draft) => {
        draft.transcriptionById[row.id] = row;
        draft.transcriptions.transcriptionIds = [row.id];
      });

      resumeInterruptedPostProcessEditRetries([row]);
      await vi.advanceTimersByTimeAsync(0);

      // The pass runs against the row the claim names, so History is updated
      // rather than appended to.
      expect(transcribeAudio).toHaveBeenCalledTimes(1);
      expect(updateTranscription).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id, transcript: "Hello there" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a claimed row alone once its pass has reported back", async () => {
    vi.useFakeTimers();
    try {
      const row = {
        ...sampleTranscription("claim-reported"),
        postProcessEditFailed: true,
        // The pass that claimed this row already failed again, which is what a
        // higher count records. Resuming it here would be a second pass.
        postProcessEditFailureCount: 4,
        postProcessEditAutoRetryUsed: true,
      };
      produceAppState((draft) => {
        draft.transcriptionById[row.id] = row;
        draft.transcriptions.transcriptionIds = [row.id];
      });

      resumeInterruptedPostProcessEditRetries([row]);
      await vi.advanceTimersByTimeAsync(0);

      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records an interrupted attempt that never reached post-processing", async () => {
    vi.useFakeTimers();
    try {
      const row = {
        ...sampleTranscription("interrupted-audio"),
        postProcessEditFailed: true,
        postProcessEditFailureCount: 3,
        postProcessEditAutoRetryUsed: true,
      };
      produceAppState((draft) => {
        draft.transcriptionById[row.id] = row;
        draft.transcriptions.transcriptionIds = [row.id];
      });
      // The audio itself is gone, so the pass fails before post-processing has
      // anything to write. Without the record below, every later launch would
      // deliver the same claim again.
      loadTranscriptionAudio.mockRejectedValueOnce(new Error("no audio"));

      resumeInterruptedPostProcessEditRetries([row]);
      await vi.advanceTimersByTimeAsync(0);

      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(updateTranscription).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id, postProcessFailed: true }),
      );
      expect(getAppState().transcriptionById[row.id]?.postProcessFailed).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not deliver a claim whose attempt is already recorded", async () => {
    vi.useFakeTimers();
    try {
      const row = {
        ...sampleTranscription("attempt-recorded"),
        postProcessEditFailed: true,
        postProcessEditFailureCount: 3,
        postProcessEditAutoRetryUsed: true,
        postProcessFailed: true,
      };
      produceAppState((draft) => {
        draft.transcriptionById[row.id] = row;
        draft.transcriptions.transcriptionIds = [row.id];
      });

      resumeInterruptedPostProcessEditRetries([row]);
      await vi.advanceTimersByTimeAsync(0);

      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(updateTranscription).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still keeps the polished transcript when a reply came back unusable", async () => {
    // The other run that sets the same flag: the request succeeded and the
    // answer was dropped, so the text this run holds is raw ASR and the row must
    // keep what it already had.
    seedStyledRow("unusable-answer", POLISHED);
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [VALIDATION_WARNING],
    );

    await retranscribeTranscription({ transcriptionId: "unusable-answer" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: POLISHED,
        rawTranscript: RAW_ASR,
        postProcessFallback: true,
      }),
    );
    expect(showErrorSnackbar).toHaveBeenCalledWith(UNREADABLE_COPY);
  });
});

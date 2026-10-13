import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "@maus-inc/types";
import type { IntlShape } from "react-intl";
import { INITIAL_APP_STATE } from "../state/app.state";
import { RETRANSCRIPTION_SUCCESS_VISIBLE_MS } from "../state/transcriptions.state";
import type { PostProcessMetadata } from "./transcribe.actions";
import { createDefaultPreferences } from "./user.actions";
import { POST_PROCESS_ERROR_CATEGORY } from "./post-process-error-category";
import { getAppState, produceAppState, setAppState } from "../store";

const {
  loadTranscriptionAudio,
  importAudioFileMock,
  updateTranscription,
  transcribeAudio,
  postProcessTranscript,
  storeTranscription,
  generateText,
  showSnackbar,
  showErrorSnackbar,
  showPersistentToast,
  showCompletionToast,
  dismissToast,
} = vi.hoisted(() => ({
  loadTranscriptionAudio: vi.fn(),
  importAudioFileMock: vi.fn(),
  updateTranscription: vi.fn(),
  transcribeAudio: vi.fn(),
  postProcessTranscript: vi.fn(),
  storeTranscription: vi.fn(),
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
  storeTranscription,
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
  getToastActionLabel: (action: string) => {
    switch (action) {
      case "open_post_processing_settings":
        return "Fix";
      case "open_transcriptions":
        return "Open history";
      default:
        return action;
    }
  },
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
  retranscribeTranscription,
  openRetranscribeDialog,
  importAudioFile: runImportAudioFile,
} = await import("./transcriptions.actions");
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

  it("combines local-fallback and fast-style truncation feedback", async () => {
    seedTranscription("truncated-fast-style");
    postProcessTranscript.mockResolvedValueOnce({
      transcript: "Fast-styled transcript",
      warnings: [],
      metadata: {
        postProcessFailed: false,
        postProcessFallback: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
        fastStyleTruncatedChars: 42,
      },
    });

    await retranscribeTranscription({
      transcriptionId: "truncated-fast-style",
    });

    const message =
      "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead. Fast styling left the last 42 characters of the audio unstyled. The unstyled ending is in History.";
    expect(showSnackbar).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        mode: "info",
        action: expect.objectContaining({ label: "Fix" }),
      }),
    );
    expect(showCompletionToast).toHaveBeenCalledWith(
      message,
      8_000,
      "open_post_processing_settings",
    );
  });

  it("keeps both rows' feedback when a batch finishes two styled fallbacks", async () => {
    seedTranscription("a");
    seedTranscription("b");
    postProcessTranscript
      .mockResolvedValueOnce({
        transcript: "Styled transcript A",
        warnings: [],
        metadata: {
          postProcessFailed: false,
          postProcessFallback: true,
          postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
        },
      })
      .mockResolvedValueOnce({
        transcript: "Styled transcript B",
        warnings: [],
        metadata: {
          postProcessFailed: false,
          postProcessFallback: true,
          postProcessError: POST_PROCESS_ERROR_CATEGORY.rateLimit,
        },
      });

    await Promise.all([
      retranscribeTranscription({ transcriptionId: "a" }),
      retranscribeTranscription({ transcriptionId: "b" }),
    ]);

    const firstMessage =
      "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead.";
    const secondMessage =
      "Online styling failed because the provider rate limit was reached. Your local style was applied instead.";
    const completionCalls = showCompletionToast.mock
      .calls as unknown as readonly [string, number?, string?][];
    const mergedCall = completionCalls.find(([message]) =>
      message.includes(secondMessage),
    );
    expect(mergedCall?.[0]).toContain(firstMessage);
    expect(mergedCall?.[0]).toContain(secondMessage);
    expect(mergedCall?.[1]).toBe(8_000);
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

  it("does not replace one concurrent retranscription error with another run's completion", async () => {
    seedTranscription("a");
    seedTranscription("b");

    let releaseA:
      ((value: { samples: number[]; sampleRate: number }) => void) | undefined;
    loadTranscriptionAudio.mockImplementation((id: string) =>
      id === "a"
        ? new Promise((resolve) => {
            releaseA = resolve;
          })
        : Promise.reject(new Error("no audio")),
    );
    postProcessTranscript.mockResolvedValueOnce({
      transcript: "Locally styled transcript",
      warnings: [],
      metadata: {
        postProcessFailed: false,
        postProcessFallback: true,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      },
    });

    const runA = retranscribeTranscription({ transcriptionId: "a" });
    const runB = retranscribeTranscription({ transcriptionId: "b" });
    await runB;

    expect(showErrorSnackbar).toHaveBeenCalledWith("no audio");
    releaseA?.({ samples: [0, 1], sampleRate: 16000 });
    await runA;

    expect(showCompletionToast).not.toHaveBeenCalled();
    expect(showSnackbar).not.toHaveBeenCalledWith(
      expect.stringContaining("Online styling failed"),
      expect.anything(),
    );
    expect(dismissToast).toHaveBeenCalled();
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

  it("does not promise History for a truncated run in an ephemeral session", async () => {
    seedGated(true);
    postProcessTranscript.mockResolvedValueOnce({
      transcript: "retranscribed text",
      warnings: [],
      metadata: { fastStyleTruncatedChars: 42 },
    });

    await retranscribeTranscription({ transcriptionId: "tx-gate" });

    const message =
      "Fast styling left the last 42 characters unstyled. The app did not save them in History.";
    expect(updateTranscription).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ mode: "info" }),
    );
    expect(showCompletionToast).toHaveBeenCalledWith(message, 8_000);
  });

  it("does not claim a failed retranscription was saved during an ephemeral session", async () => {
    seedGated(true);
    postProcessTranscript.mockResolvedValueOnce({
      transcript: "raw retranscribed",
      warnings: [POST_PROCESS_ERROR_CATEGORY.providerLimit],
      metadata: {
        postProcessFailed: true,
        postProcessFallback: false,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
      },
    });

    await retranscribeTranscription({ transcriptionId: "tx-gate" });

    expect(updateTranscription).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith(
      "Styling failed because the provider request or usage limit was reached. The raw transcript is available in this session, but was not saved in History.",
      expect.objectContaining({ mode: "error", action: undefined }),
    );
  });
});

describe("retranscribeTranscription unstyled post-processing", () => {
  const POLISHED = "Polished summary of the call.";
  const RAW_ASR = "raw asr from this run";
  /** The category `recordPostProcessFailure` records for a 402. */
  const QUOTA_CATEGORY = "Quota or payment required (402)";
  /** Localized reason shown inside the shared styling-failure feedback. */
  const QUOTA_REASON = "the provider reported a quota or billing issue";
  const QUOTA_COPY =
    "Styling failed because the provider reported a quota or billing issue. The raw transcript is saved in History.";
  /** The reason recorded for an answer that parsed but failed validation. */
  const VALIDATION_WARNING =
    "Post-processing response validation failed: result is required";
  /** Localized copy for a reply that ran out of the model's output budget. */
  const TRUNCATED_COPY =
    "The incomplete styling reply was discarded at the model's output limit. The previous text was kept.";
  /** Localized copy for a reply that came back unreadable. */
  const UNREADABLE_COPY =
    "The unreadable styling reply was discarded, leaving the previous text in place.";
  const UNREADABLE_EMPTY_COPY =
    "The invalid styling reply was discarded, and the raw transcript was saved instead.";

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
    [
      ...showSnackbar.mock.calls.map(([message]) => String(message)),
      ...showErrorSnackbar.mock.calls.map(([message]) => String(message)),
    ].join(" ");

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
    // The error includes a localized cause and a link back to History. The
    // provider's category remains internal and is never shown verbatim.
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(showCompletionToast).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith(
      QUOTA_COPY,
      expect.objectContaining({
        mode: "error",
        action: expect.objectContaining({ label: "Open history" }),
      }),
    );
    expect(showErrorSnackbar).not.toHaveBeenCalled();
    expect(shownToUser()).not.toContain(QUOTA_CATEGORY);
    expect(intlFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMessage: QUOTA_REASON }),
    );
    expect(console.error).toHaveBeenCalledWith(
      "Failed to retranscribe audio",
      QUOTA_CATEGORY,
    );
  });

  it("preserves the History action when failure and truncation feedback are combined", async () => {
    seedStyledRow("failed-truncated", POLISHED);
    mockUnstyledPostProcess(
      {
        postProcessFailed: true,
        postProcessFallback: false,
        postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
        fastStyleTruncatedChars: 42,
      },
      [POST_PROCESS_ERROR_CATEGORY.providerLimit],
    );

    await retranscribeTranscription({ transcriptionId: "failed-truncated" });

    expect(showSnackbar).toHaveBeenCalledWith(
      "Styling failed because the provider request or usage limit was reached. The raw transcript is saved in History. Fast styling left the last 42 characters of the audio unstyled. The unstyled ending is in History.",
      expect.objectContaining({
        mode: "error",
        action: expect.objectContaining({ label: "Open history" }),
      }),
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
    // The stored warning stays internal, while the informational feedback
    // distinguishes an unusable reply from a provider request failure.
    expect(showSnackbar).toHaveBeenCalledWith(
      TRUNCATED_COPY,
      expect.objectContaining({ mode: "info" }),
    );
    expect(showErrorSnackbar).not.toHaveBeenCalled();
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
    expect(showErrorSnackbar).not.toHaveBeenCalled();
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
    // Unusable styling is not a finished retranscription. The informational
    // feedback names the outcome without exposing parser or validation details.
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
    expect(showCompletionToast).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith(
      UNREADABLE_COPY,
      expect.objectContaining({ mode: "info" }),
    );
    expect(showErrorSnackbar).not.toHaveBeenCalled();
    expect(shownToUser()).not.toContain("Could not parse or repair");
    expect(shownToUser()).not.toContain(unparsed.warnings[0]);
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
    // The recorded reason is not shown. The toast describes the unusable reply,
    // without borrowing the cut-off copy or exposing schema details.
    expect(showSnackbar).toHaveBeenCalledWith(
      UNREADABLE_EMPTY_COPY,
      expect.objectContaining({ mode: "info" }),
    );
    expect(showErrorSnackbar).not.toHaveBeenCalled();
    expect(shownToUser()).not.toContain("validation failed");
    expect(shownToUser()).not.toContain(VALIDATION_WARNING);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to retranscribe audio",
      VALIDATION_WARNING,
    );
  });

  it("uses raw ASR for a whitespace-only previous transcript", async () => {
    seedStyledRow("whitespace-only", "   ");
    mockUnstyledPostProcess(
      { postProcessFailed: false, postProcessFallback: true },
      [VALIDATION_WARNING],
    );

    await retranscribeTranscription({ transcriptionId: "whitespace-only" });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: RAW_ASR,
        rawTranscript: RAW_ASR,
      }),
    );
    expect(showSnackbar).toHaveBeenCalledWith(
      UNREADABLE_EMPTY_COPY,
      expect.objectContaining({ mode: "info" }),
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
    expect(showSnackbar).toHaveBeenCalledWith(
      TRUNCATED_COPY,
      expect.objectContaining({ mode: "info" }),
    );

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
    expect(showSnackbar).toHaveBeenCalledWith(
      UNREADABLE_COPY,
      expect.objectContaining({ mode: "info" }),
    );
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

    const shown = showSnackbar.mock.calls
      .map(([message]) => String(message))
      .filter((message) => [TRUNCATED_COPY, UNREADABLE_COPY].includes(message));
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
    const fallbackMessage =
      "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead.";
    expect(showSnackbar).toHaveBeenCalledWith(
      fallbackMessage,
      expect.objectContaining({
        mode: "info",
        action: expect.objectContaining({ label: "Fix" }),
      }),
    );
    expect(showCompletionToast).toHaveBeenCalledWith(
      fallbackMessage,
      4000,
      "open_post_processing_settings",
    );
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([
      "degraded",
    ]);
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
    expect(showSnackbar).toHaveBeenCalledWith(
      UNREADABLE_COPY,
      expect.objectContaining({ mode: "info" }),
    );
  });
});

describe("importAudioFile post-processing feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    importAudioFileMock.mockResolvedValue({
      samples: [0.1, 0.2],
      sampleRate: 16000,
    });
    transcribeAudio.mockResolvedValue({
      rawTranscript: "um imported audio",
      sanitizedTranscript: "um imported audio",
      warnings: [],
      metadata: {},
    });
    storeTranscription.mockResolvedValue({
      transcription: sampleTranscription("imported"),
    });
  });

  const setPostProcessResult = (
    metadata: PostProcessMetadata,
    warnings: string[] = [],
  ) => {
    postProcessTranscript.mockResolvedValue({
      transcript: "Imported transcript",
      warnings,
      metadata,
    });
  };

  it("explains a provider failure and offers settings after local styling", async () => {
    setPostProcessResult({
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
    });

    await expect(runImportAudioFile({ toneId: "default" })).resolves.toBe(true);

    expect(showSnackbar).toHaveBeenCalledWith(
      "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead.",
      expect.objectContaining({
        mode: "info",
        action: expect.objectContaining({ label: "Fix" }),
      }),
    );
  });

  it("combines local-fallback and fast-style truncation feedback", async () => {
    setPostProcessResult({
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
      fastStyleTruncatedChars: 42,
    });

    await expect(runImportAudioFile({ toneId: "default" })).resolves.toBe(true);

    expect(showSnackbar).toHaveBeenCalledWith(
      "Online styling failed because the provider reported a quota or billing issue. Your local style was applied instead. Fast styling left the last 42 characters of the audio unstyled. The unstyled ending is in History.",
      expect.objectContaining({
        mode: "info",
        action: expect.objectContaining({ label: "Fix" }),
      }),
    );
  });

  it("preserves the History action when failure and truncation feedback are combined", async () => {
    setPostProcessResult({
      postProcessFailed: true,
      postProcessFallback: false,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
      fastStyleTruncatedChars: 42,
    });

    await runImportAudioFile({ toneId: "default" });

    expect(showSnackbar).toHaveBeenCalledWith(
      "Styling failed because the provider request or usage limit was reached. The raw transcript is saved in History. Fast styling left the last 42 characters of the audio unstyled. The unstyled ending is in History.",
      expect.objectContaining({
        mode: "error",
        action: expect.objectContaining({ label: "Open history" }),
      }),
    );
  });

  it("warns when imported fast styling leaves the audio tail unstyled", async () => {
    setPostProcessResult({ fastStyleTruncatedChars: 42 });

    await expect(runImportAudioFile({ toneId: "default" })).resolves.toBe(true);

    expect(showSnackbar).toHaveBeenCalledWith(
      "Fast styling left the last 42 characters of the audio unstyled. The unstyled ending is in History.",
      expect.objectContaining({ mode: "info", action: undefined }),
    );
  });

  it("reports a complete styling failure and offers History", async () => {
    setPostProcessResult({
      postProcessFailed: true,
      postProcessFallback: false,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
    });

    await runImportAudioFile({ toneId: "default" });

    expect(showSnackbar).toHaveBeenCalledWith(
      "Styling failed because the provider request or usage limit was reached. The raw transcript is saved in History.",
      expect.objectContaining({
        mode: "error",
        action: expect.objectContaining({ label: "Open history" }),
      }),
    );
  });

  it("does not promise History when a failed import was not stored", async () => {
    setPostProcessResult({
      postProcessFailed: true,
      postProcessFallback: false,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
    });
    storeTranscription.mockResolvedValue({ transcription: null });

    await runImportAudioFile({ toneId: "default" });

    expect(showSnackbar).toHaveBeenCalledWith(
      "Styling failed because the provider request or usage limit was reached. The raw transcript is available in this session, but was not saved in History.",
      expect.objectContaining({ mode: "error", action: undefined }),
    );
  });

  it("does not promise History for truncated imported audio in incognito mode", async () => {
    setPostProcessResult({ fastStyleTruncatedChars: 42 });
    const state = structuredClone(INITIAL_APP_STATE);
    state.userPrefs = createDefaultPreferences();
    state.userPrefs.incognitoModeEnabled = true;
    setAppState(state, true);
    storeTranscription.mockResolvedValue({ transcription: null, wordCount: 0 });

    await expect(runImportAudioFile({ toneId: "default" })).resolves.toBe(true);

    expect(showSnackbar).toHaveBeenCalledWith(
      "Fast styling left the last 42 characters unstyled. The app did not save them in History.",
      expect.objectContaining({ mode: "info", action: undefined }),
    );
  });

  it("does not promise History for an unusable imported reply in incognito mode", async () => {
    setPostProcessResult({
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: null,
    });
    const state = structuredClone(INITIAL_APP_STATE);
    state.userPrefs = createDefaultPreferences();
    state.userPrefs.incognitoModeEnabled = true;
    setAppState(state, true);
    storeTranscription.mockResolvedValue({ transcription: null, wordCount: 0 });

    await runImportAudioFile({ toneId: "default" });

    expect(showSnackbar).toHaveBeenCalledWith(
      "The online styling reply was unusable. The original transcript is available in this session, but was not saved in History.",
      expect.objectContaining({ mode: "info", action: undefined }),
    );
  });

  it("uses the original transcript when an online reply is unusable", async () => {
    setPostProcessResult({
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: null,
    });

    await runImportAudioFile({ toneId: "default" });

    expect(showSnackbar).toHaveBeenCalledWith(
      "The original transcript was saved because the online styling reply was unusable.",
      expect.objectContaining({ mode: "info" }),
    );
    expect(showSnackbar.mock.calls.at(-1)?.[0]).not.toContain("local style");
  });
});

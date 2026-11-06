import { afterEach, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import type {
  StopRecordingResponse,
  TranscriptionSessionResult,
} from "../../types/transcription-session.types";
import type { PipelineTrace } from "../../utils/pipeline-trace";
const mocks = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: mocks.warning }),
}));
import { createReviewedTranscriptPersistence } from "./dictation-review-persistence";

afterEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  vi.clearAllMocks();
});

it("persists the original recording trace even after a successor owns the live ref", async () => {
  const oldTrace = { stopped: 1 } as unknown as PipelineTrace;
  const traceRef = { current: oldTrace };
  const store = vi.fn().mockResolvedValue({ transcription: { id: "saved" } });
  const surface = vi.fn().mockResolvedValue(undefined);
  const persist = createReviewedTranscriptPersistence({
    audio: {
      samples: new Float32Array(),
      sampleRate: 16_000,
    } as StopRecordingResponse,
    rawTranscript: "original",
    transcribeResult: {
      rawTranscript: "original",
      metadata: {},
      warnings: ["provider"],
    } as TranscriptionSessionResult,
    trace: traceRef.current,
    store,
    surface,
    showToast: vi.fn(),
    formatFailure: () => "failed",
  });
  traceRef.current = { stopped: 2 } as unknown as PipelineTrace;
  await expect(
    persist({
      transcript: "edited",
      sanitizedTranscript: "edited",
      postProcessMetadata: {},
      postProcessWarnings: ["style"],
    }),
  ).resolves.toBe(true);
  expect(store).toHaveBeenCalledWith(
    expect.objectContaining({
      trace: oldTrace,
      warnings: ["provider", "style"],
      transcript: "edited",
    }),
  );
  expect(surface).toHaveBeenCalledOnce();
});
it.each(["pending", "reject", "throw"] as const)(
  "reports a durable review even when surfacing History is %s",
  async (outcome) => {
    const surface = vi.fn(() => {
      if (outcome === "throw") throw new Error("window failed");
      if (outcome === "reject")
        return Promise.reject(new Error("window failed"));
      return new Promise<void>(() => {});
    });
    const persist = createReviewedTranscriptPersistence({
      audio: { samples: new Float32Array(), sampleRate: 16_000 },
      rawTranscript: "original",
      transcribeResult: {
        rawTranscript: "original",
        metadata: {},
        warnings: [],
      },
      trace: null,
      store: vi.fn().mockResolvedValue({ transcription: { id: "saved" } }),
      surface,
      showToast: vi.fn().mockResolvedValue(undefined),
      formatFailure: () => "failed",
    });
    const result = await Promise.race([
      persist({
        transcript: "edited",
        sanitizedTranscript: "edited",
        postProcessMetadata: {},
        postProcessWarnings: [],
      }),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 100),
      ),
    ]);
    expect(result).toBe(true);
    expect(surface).toHaveBeenCalledOnce();
  },
);

it("does not wait for a failed-review toast before retaining the edit", async () => {
  const persist = createReviewedTranscriptPersistence({
    audio: { samples: new Float32Array(), sampleRate: 16_000 },
    rawTranscript: "original",
    transcribeResult: { rawTranscript: "original", metadata: {}, warnings: [] },
    trace: null,
    store: vi.fn().mockResolvedValue({ transcription: null }),
    surface: vi.fn(),
    showToast: vi.fn(() => new Promise(() => {})),
    formatFailure: () => "retry",
  });
  const result = await Promise.race([
    persist({
      transcript: "edited",
      sanitizedTranscript: "edited",
      postProcessMetadata: {},
      postProcessWarnings: [],
    }),
    new Promise<"stalled">((resolve) =>
      setTimeout(() => resolve("stalled"), 100),
    ),
  ]);
  expect(result).toBe(false);
});

it("reports a failed review save without surfacing history", async () => {
  const store = vi.fn().mockRejectedValue(new Error("storage failed"));
  const surface = vi.fn();
  const showToast = vi.fn().mockResolvedValue(undefined);
  const persist = createReviewedTranscriptPersistence({
    audio: {
      samples: new Float32Array(),
      sampleRate: 16_000,
    } as StopRecordingResponse,
    rawTranscript: "original",
    transcribeResult: {
      rawTranscript: "original",
      metadata: {},
      warnings: [],
    } as TranscriptionSessionResult,
    trace: null,
    store,
    surface,
    showToast,
    formatFailure: () => "retry",
  });
  await expect(
    persist({
      transcript: "edited",
      sanitizedTranscript: "edited",
      postProcessMetadata: {},
      postProcessWarnings: [],
    }),
  ).resolves.toBe(false);
  expect(surface).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: "retry", toastType: "error" }),
  );
});

it.each(["before-store", "after-store", "store-error"] as const)(
  "does not publish reviewed audio to a successor session (%s)",
  async (stage) => {
    let finish!: (value: { transcription: { id: string } }) => void;
    let fail!: (error: Error) => void;
    const store = vi.fn(
      () =>
        new Promise<{ transcription: { id: string } }>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const surface = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn().mockResolvedValue(undefined);
    const persist = createReviewedTranscriptPersistence({
      audio: { samples: new Float32Array(), sampleRate: 16_000 },
      rawTranscript: "original",
      transcribeResult: {
        rawTranscript: "original",
        metadata: {},
        warnings: [],
      } as TranscriptionSessionResult,
      trace: null,
      store:
        store as unknown as typeof import("../../actions/transcribe.actions").storeTranscription,
      surface,
      showToast,
      formatFailure: () => "failed",
    });
    if (stage === "before-store") setAppState({ authSessionNonce: 1 });
    const pending = persist({
      transcript: "edited",
      sanitizedTranscript: "edited",
      postProcessMetadata: {},
      postProcessWarnings: [],
    });
    if (stage !== "before-store") {
      setAppState({ authSessionNonce: 1 });
      if (stage === "store-error") fail(new Error("old failure"));
      else finish({ transcription: { id: "old" } });
    }
    expect(await pending).toBe(false);
    if (stage === "before-store") expect(store).not.toHaveBeenCalled();
    expect(surface).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
  },
);

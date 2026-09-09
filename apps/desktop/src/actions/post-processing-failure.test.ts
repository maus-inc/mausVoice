import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";

const { genRepo, loggerMock } = vi.hoisted(() => {
  const genRepo = {
    generateText: vi.fn(),
    streamChat: vi.fn(),
  };
  return {
    genRepo,
    loggerMock: {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      verbose: vi.fn(),
      stopwatch: vi.fn(async (_label: string, fn: () => Promise<unknown>) => {
        const result = await fn();
        return result;
      }),
    },
  };
});

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));
vi.mock("../repos", () => ({
  getGenerateTextRepo: () => ({
    repo: genRepo,
    apiKeyId: "cerebras-key",
    provider: "cerebras",
    warnings: [],
  }),
  getTranscribeAudioRepo: () => ({ repo: null, apiKeyId: null, warnings: [] }),
  getTranscriptionRepo: () => ({}),
}));
vi.mock("../utils/tone.utils", () => ({
  getToneById: () => null,
  getToneConfig: () => ({ name: "Default", prompt: "" }),
}));
vi.mock("../utils/user.utils", async () => {
  const actual = await vi.importActual<typeof import("../utils/user.utils")>(
    "../utils/user.utils",
  );
  return {
    ...actual,
    getMyUserName: () => "Tester",
    loadMyEffectiveDictationLanguage: () => Promise.resolve("en"),
  };
});

import { postProcessTranscript } from "./transcribe.actions";

describe("postProcessTranscript provider attribution on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("keeps the raw transcript and records Cerebras attribution after a 402", async () => {
    class Cerebras402 extends Error {
      status = 402;
      constructor() {
        super("402 status code (no body)");
        this.name = "CerebrasProviderError";
      }
    }
    genRepo.generateText.mockRejectedValueOnce(new Cerebras402());

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    // The raw transcript is preserved (not replaced or dropped).
    expect(result.transcript).toBe("hello world");
    // Attribution is persisted despite the failure.
    expect(result.metadata.postProcessApiKeyId).toBe("cerebras-key");
    expect(result.metadata.postProcessProvider).toBe("cerebras");
    expect(result.metadata.postProcessMode).toBe("api");
    expect(result.metadata.postProcessFailed).toBe(true);
    expect(result.metadata.postProcessError).toContain("402");
    // The failure is surfaced as a warning, not thrown.
    expect(result.warnings.join(" ")).toContain("402");
  });

  it("aborts the provider signal after a non-timeout failure", async () => {
    let seenSignal: AbortSignal | undefined;
    genRepo.generateText.mockImplementationOnce(
      async (input: { signal?: AbortSignal }) => {
        seenSignal = input.signal;
        throw new Error("provider rejected the request");
      },
    );

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    expect(result.transcript).toBe("hello world");
    expect(result.metadata.postProcessFailed).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("records provider metadata on success", async () => {
    genRepo.generateText.mockResolvedValueOnce({
      text: JSON.stringify({ result: "Hello, world." }),
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Cerebras",
      },
    });

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    expect(result.transcript).toBe("Hello, world.");
    expect(result.metadata.postProcessProvider).toBe("cerebras");
    expect(result.metadata.postProcessApiKeyId).toBe("cerebras-key");
    // Success must clear failure flags so a reprocess of a previously-failed
    // row never leaves stale postProcessFailed=true on the updated record.
    expect(result.metadata.postProcessFailed).toBe(false);
    expect(result.metadata.postProcessError).toBeNull();
  });

  it.each([
    ["captures the resolved model", "qwen-3-235b", "qwen-3-235b"],
    ["leaves the model null when the repo reports none", undefined, null],
  ])("%s", async (_name, reportedModel, expected) => {
    genRepo.generateText.mockResolvedValueOnce({
      text: JSON.stringify({ result: "Hello, world." }),
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Cerebras",
        ...(reportedModel === undefined ? {} : { model: reportedModel }),
      },
    });

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    expect(result.metadata.postProcessModel).toBe(expected);
  });

  it("aborts a hung provider request when the post-process deadline expires", async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      genRepo.generateText.mockImplementationOnce(
        (input: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            seenSignal = input.signal;
            input.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );

      const running = postProcessTranscript({
        rawTranscript: "hello world",
        toneId: null,
      });
      await vi.advanceTimersByTimeAsync(50_001);
      const result = await running;

      // Deadline expiry must cancel the underlying request instead of
      // leaving it running in the background, and fall back to the raw
      // transcript with failure metadata.
      expect(seenSignal?.aborted).toBe(true);
      expect(result.transcript).toBe("hello world");
      expect(result.metadata.postProcessFailed).toBe(true);
      // The abort fires at the same tick as the deadline rejection; either
      // surface is acceptable as long as the failure is recorded.
      expect(result.metadata.postProcessError).toMatch(/timed out|aborted/);
    } finally {
      vi.useRealTimers();
    }
  });
});

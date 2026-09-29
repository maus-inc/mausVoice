import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../utils/tone.utils", async () => {
  const actual = await vi.importActual<typeof import("../utils/tone.utils")>(
    "../utils/tone.utils",
  );
  return {
    ...actual,
    getToneById: () => null,
    getToneConfig: () => ({ name: "Default", prompt: "" }),
  };
});
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

  it("redacts echoed transcript text from logs, warnings, and metadata failure category", async () => {
    const sentinelTranscript = "super-secret-user-transcription-content-xyz";
    genRepo.generateText.mockRejectedValueOnce(
      new Error(
        `Internal provider failure while processing text: "${sentinelTranscript}"`,
      ),
    );

    const result = await postProcessTranscript({
      rawTranscript: sentinelTranscript,
      toneId: null,
    });

    expect(result.transcript).toBe(sentinelTranscript);
    expect(result.metadata.postProcessFailed).toBe(true);
    // Metadata failure category must be a fixed category without transcript text
    expect(result.metadata.postProcessError).not.toContain(sentinelTranscript);
    expect(result.metadata.postProcessError).toBe(
      "Post-processing provider error",
    );
    // Warnings must not contain transcript text
    expect(result.warnings.join(" ")).not.toContain(sentinelTranscript);
    // Logger must not contain unredacted transcript text
    const loggedCalls = loggerMock.error.mock.calls
      .map((c) => String(c[0]))
      .join(" ");
    expect(loggedCalls).not.toContain(sentinelTranscript);
    expect(loggedCalls).toContain("[REDACTED_TRANSCRIPT]");
  });
});

describe("postProcessTranscript fast local style", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    // The provider-less cases install a spy on getGenerateTextRepo. Without an
    // explicit restore it leaks into the next test and the fast-fallback case
    // would silently exercise the provider-less path instead.
    vi.restoreAllMocks();
  });

  it("degrades to the local style on a provider failure without erasing the failure signal", async () => {
    class Cerebras402 extends Error {
      status = 402;
      constructor() {
        super("402 status code (no body)");
        this.name = "CerebrasProviderError";
      }
    }
    genRepo.generateText.mockRejectedValueOnce(new Cerebras402());

    const result = await postProcessTranscript({
      rawTranscript: "um so I went to the store",
      toneId: "default",
    });

    // The user still gets styled output instead of the raw transcript.
    expect(result.transcript.toLowerCase()).not.toContain("um");
    expect(result.metadata.postProcessMode).toBe("fast");

    // The failure must stay visible: the provider error is recorded and the
    // row is marked as a fallback. Before this was fixed the fallback cleared
    // postProcessError, hiding the 402 entirely.
    expect(result.metadata.postProcessError).toContain("402");
    expect(result.metadata.postProcessFallback).toBe(true);

    // The transcript must still be delivered. postProcessFailed gates insertion
    // in the dictation strategy, so a local fallback that produced usable text
    // must not set it, or the styled output never reaches the active app.
    expect(result.metadata.postProcessFailed).toBe(false);

    // Provider attribution records the user's choice, not the local fallback.
    expect(result.metadata.postProcessProvider).toBe("cerebras");
    expect(result.metadata.postProcessApiKeyId).toBe("cerebras-key");

    // No LLM model ran, so the model column must not claim one did.
    expect(result.metadata.postProcessModel).toBeNull();
    // The recorded duration is the local transform, not the network wait.
    expect(result.metadata.postprocessDurationMs).toBeLessThan(
      result.metadata.postprocessDurationMs === null
        ? Number.POSITIVE_INFINITY
        : 60_000,
    );
    expect(result.warnings.join(" ")).toContain("402");
    expect(result.warnings.join(" ")).toContain("Fast local style");
  });

  it("returns the raw transcript unchanged when the tone has no local style", async () => {
    genRepo.generateText.mockRejectedValueOnce(new Error("provider rejected"));

    const result = await postProcessTranscript({
      rawTranscript: "um so I went to the store",
      toneId: "verbatim",
    });

    expect(result.transcript).toBe("um so I went to the store");
    expect(result.metadata.postProcessMode).toBe("api");
    expect(result.metadata.postProcessFailed).toBe(true);
  });

  it("records no fallback flag when no provider call was made", async () => {
    const { postProcessTranscript: run } = await import("./transcribe.actions");
    const repos = await import("../repos");
    const spy = vi.spyOn(repos, "getGenerateTextRepo").mockReturnValueOnce({
      repo: null,
      apiKeyId: null,
      provider: null,
      warnings: [],
    } as unknown as ReturnType<typeof repos.getGenerateTextRepo>);

    const result = await run({
      rawTranscript: "um so I went to the store",
      toneId: "default",
    });

    spy.mockRestore();
    // The fast path was taken by design, not because a provider failed.
    expect(result.metadata.postProcessMode).toBe("fast");
    expect(result.metadata.postProcessFallback).toBeFalsy();
    expect(result.metadata.postProcessFailed).toBeFalsy();
  });

  it("uses the local style when no provider is configured, and reports no model", async () => {
    const { postProcessTranscript: run } = await import("./transcribe.actions");
    const repos = await import("../repos");
    const spy = vi.spyOn(repos, "getGenerateTextRepo").mockReturnValueOnce({
      repo: null,
      apiKeyId: null,
      provider: null,
      warnings: [],
    } as unknown as ReturnType<typeof repos.getGenerateTextRepo>);

    const result = await run({
      rawTranscript: "um so I went to the store",
      toneId: "bullets",
    });

    spy.mockRestore();
    expect(result.metadata.postProcessMode).toBe("fast");
    expect(result.metadata.postProcessModel).toBeNull();
    expect(result.transcript).toContain("- ");
  });

  it("records the dropped count on the no-provider fast path", async () => {
    const { FAST_STYLE_MAX_INPUT_CHARS } =
      await import("../utils/fast-style.utils");
    const overCap = "dictation word ".repeat(2000);
    expect(overCap.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);

    const { postProcessTranscript: run } = await import("./transcribe.actions");
    const repos = await import("../repos");
    const spy = vi.spyOn(repos, "getGenerateTextRepo").mockReturnValueOnce({
      repo: null,
      apiKeyId: null,
      provider: null,
      warnings: [],
    } as unknown as ReturnType<typeof repos.getGenerateTextRepo>);

    const result = await run({
      rawTranscript: overCap,
      toneId: "default",
    });

    spy.mockRestore();
    expect(result.metadata.postProcessMode).toBe("fast");
    expect(result.metadata.fastStyleTruncatedChars).toBe(
      overCap.length - FAST_STYLE_MAX_INPUT_CHARS,
    );
    expect(result.warnings.join(" ")).toContain("left unstyled");
    expect(result.warnings.join(" ")).toContain(
      String(overCap.length - FAST_STYLE_MAX_INPUT_CHARS),
    );
  });

  it("records the dropped count on the fast fallback path after a provider failure", async () => {
    const { FAST_STYLE_MAX_INPUT_CHARS } =
      await import("../utils/fast-style.utils");
    const overCap = "dictation word ".repeat(2000);
    genRepo.generateText.mockRejectedValueOnce(new Error("provider down"));

    const result = await postProcessTranscript({
      rawTranscript: overCap,
      toneId: "default",
    });

    // Assert the fallback really ran, so this case cannot pass by way of the
    // provider-less branch.
    expect(result.metadata.postProcessFallback).toBe(true);
    expect(result.metadata.postProcessMode).toBe("fast");
    expect(result.metadata.fastStyleTruncatedChars).toBe(
      overCap.length - FAST_STYLE_MAX_INPUT_CHARS,
    );
    expect(result.warnings.join(" ")).toContain("left unstyled");
  });

  it("reports no truncation for input under the cap", async () => {
    genRepo.generateText.mockRejectedValueOnce(new Error("provider down"));

    const result = await postProcessTranscript({
      rawTranscript: "a short dictation",
      toneId: "default",
    });

    expect(result.metadata.fastStyleTruncatedChars).toBeUndefined();
    expect(result.warnings.join(" ")).not.toContain("left unstyled");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";

const { genRepo, loggerMock, repoWarnings } = vi.hoisted(() => {
  const genRepo = {
    generateText: vi.fn(),
    streamChat: vi.fn(),
  };
  return {
    genRepo,
    repoWarnings: [] as string[],
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
    warnings: repoWarnings,
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

import {
  postProcessTranscript,
  POST_PROCESS_PARSE_FAILURE_PREFIX,
} from "./transcribe.actions";
import { POST_PROCESS_TRUNCATED_WARNING } from "../utils/prompt.utils";

describe("postProcessTranscript provider attribution on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoWarnings.length = 0;
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

describe("postProcessTranscript truncated responses", () => {
  // A Cerebras or DeepSeek response arrives as bare JSON, so a body cut at
  // POST_PROCESS_MAX_TOKENS lands here with no fence to give the truncation
  // away. The repair loop still recovers a fragment, and that fragment must
  // never be mistaken for the finished answer.
  const TRUNCATED_INPUT =
    '{"result": "Hello there, this is a very long dictation that keeps';

  beforeEach(() => {
    vi.clearAllMocks();
    repoWarnings.length = 0;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("falls back to the raw transcript and flags the run as degraded", async () => {
    genRepo.generateText.mockResolvedValueOnce({
      text: TRUNCATED_INPUT,
      metadata: { postProcessingMode: "api" },
    });

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    expect(result.transcript).toBe("hello world");
    // The request itself succeeded, so the persisted failure sentinel must not
    // be flipped: it backs a null/failed/succeeded column read by History.
    expect(result.metadata.postProcessFailed).toBe(false);
    expect(result.metadata.postProcessDegraded).toBe(true);
    const warnings = result.warnings.join(" ");
    expect(warnings).toContain(POST_PROCESS_TRUNCATED_WARNING);
    // The fragment was discarded, so this is not the pre-existing catch path
    // that reports an unrecoverable parse error.
    expect(warnings).not.toContain(POST_PROCESS_PARSE_FAILURE_PREFIX);
  });

  it("keeps reporting an unrecoverable fenced response as a parse failure", async () => {
    genRepo.generateText.mockResolvedValueOnce({
      // Cut inside a code fence: the missing closing backticks leave residue
      // that no repair candidate can clear, so this still throws.
      text: '```json\n{"result": "Hello there, this is a very long dictation that ke',
      metadata: { postProcessingMode: "api" },
    });

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    expect(result.transcript).toBe("hello world");
    expect(result.metadata.postProcessFailed).toBe(false);
    // The answer was unusable even though the request came back, so the run is
    // degraded. Reporting it as a success is what let a retranscription
    // overwrite the row's polished text with this raw ASR fallback.
    expect(result.metadata.postProcessDegraded).toBe(true);
    const warnings = result.warnings.join(" ");
    expect(warnings).toContain(POST_PROCESS_PARSE_FAILURE_PREFIX);
    // Nothing usable came back, but the response was not a truncated one, so
    // it must not borrow the truncation copy.
    expect(warnings).not.toContain(POST_PROCESS_TRUNCATED_WARNING);
  });

  it("leaves a complete response unflagged", async () => {
    genRepo.generateText.mockResolvedValueOnce({
      text: '{"result": "Hello there."} Hope this helps!',
      metadata: { postProcessingMode: "api" },
    });

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    expect(result.transcript).toBe("Hello there.");
    expect(result.metadata.postProcessDegraded).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("appends the drop reason after any dispatch warning, so the cause is the last entry", async () => {
    // A run can carry more than one warning. The generate-text repo
    // contributes its dispatch and glossary warnings first, and the reason this
    // answer was dropped lands after them. The surface that reports the run
    // reads the last entry, so this is the case where the first entry and the
    // last entry are different strings, and where reading `warnings[0]` would
    // report the wrong cause.
    const DISPATCH_WARNING = "Stale provider selection, using default dispatch";
    repoWarnings.push(DISPATCH_WARNING);
    genRepo.generateText.mockResolvedValueOnce({
      text: TRUNCATED_INPUT,
      metadata: { postProcessingMode: "api" },
    });

    const result = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toBe(DISPATCH_WARNING);
    expect(result.warnings.at(-1)).toBe(POST_PROCESS_TRUNCATED_WARNING);
  });

  // The surface that reports an unusable reply maps this recorded reason to
  // localized copy, and it can only pick between "cut off" and "unreadable" if
  // the two stay separate values here. A truncation copy folded into the parse
  // failure, or a parse failure that started with the truncation copy, would
  // collapse both causes into one sentence for the user.
  it("records a cut-off reply and an unreadable one as separate reasons", async () => {
    genRepo.generateText.mockResolvedValueOnce({
      text: TRUNCATED_INPUT,
      metadata: { postProcessingMode: "api" },
    });
    const truncated = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    genRepo.generateText.mockResolvedValueOnce({
      text: '```json\n{"result": "Hello there, this is a very long dictation that ke',
      metadata: { postProcessingMode: "api" },
    });
    const unreadable = await postProcessTranscript({
      rawTranscript: "hello world",
      toneId: null,
    });

    // The surface that reports an unusable reply reads the LAST warning, so
    // that is the entry pinned here. Each run records exactly one reason, so
    // the equality also fails the moment a second warning joins the list and
    // the last entry stops being the cause. Reading `warnings[0]` instead
    // would let this test pass while the classifier reads a different entry.
    expect(truncated.warnings).toEqual([POST_PROCESS_TRUNCATED_WARNING]);
    expect(truncated.warnings.at(-1)).not.toContain(
      POST_PROCESS_PARSE_FAILURE_PREFIX,
    );
    expect(unreadable.warnings).toEqual([
      expect.stringMatching(
        new RegExp(`^${POST_PROCESS_PARSE_FAILURE_PREFIX}`),
      ),
    ]);
    expect(unreadable.warnings.at(-1)).not.toContain(
      POST_PROCESS_TRUNCATED_WARNING,
    );
  });
});

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
});

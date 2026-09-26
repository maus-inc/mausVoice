import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCompatibleTranscribeAudio } from "../src/openai-compatible-transcribe.utils";
import { runSdkTranscription } from "../src/transcription.utils";

/**
 * How long one wait between attempts may last. Pinned here as well as in the
 * shared helper's own test, so moving either one has to be deliberate.
 */
const INTERACTIVE_CEILING_MS = 2_000;

const audio = new ArrayBuffer(8);

/** The shape a provider SDK raises for a rate limit that states a wait. */
const rateLimited = () =>
  Object.assign(new Error("429 Too Many Requests"), {
    status: 429,
    headers: { "retry-after": "60" },
  });

/**
 * The two transcription call sites are the ones that must never stall. Both
 * normalise the SDK error with `toHttpError` and hand it to the shared helper,
 * so an honest `Retry-After: 60` governed the wait and a live dictation sat
 * there for a minute: two waits of the 30 second parse cap, then the failure.
 */
describe("a dictation never waits out a long Retry-After", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("openaiCompatibleTranscribeAudio retries within the interactive ceiling", async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockRejectedValue(rateLimited());
    const outcome = openaiCompatibleTranscribeAudio({
      client: { audio: { transcriptions: { create } } },
      blob: audio,
      model: "whisper-1",
      ext: "wav",
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERACTIVE_CEILING_MS);
    expect(create).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERACTIVE_CEILING_MS);

    await expect(outcome).resolves.toMatchObject({ status: 429 });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("runSdkTranscription retries within the interactive ceiling", async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockRejectedValue(rateLimited());
    const outcome = runSdkTranscription(create, {
      file: audio,
      model: "whisper-1",
      response_format: "json",
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERACTIVE_CEILING_MS);
    expect(create).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERACTIVE_CEILING_MS);

    await expect(outcome).resolves.toMatchObject({ status: 429 });
    expect(create).toHaveBeenCalledTimes(3);
  });
});

type Module = Record<string, unknown>;

type ProviderCase = {
  label: string;
  /** Install the mock the provider's transport goes through. */
  mock: (fail: () => never) => void;
  unmock: () => void;
  load: () => Promise<Module>;
  run: (mod: Module, signal: AbortSignal) => Promise<unknown>;
  /** How many requests reached the transport, however the provider spells it. */
  attempts: () => number;
};

const invoke =
  (mod: Module, functionName: string) =>
  (params: Record<string, unknown>): Promise<unknown> =>
    (mod[functionName] as (args: Record<string, unknown>) => Promise<unknown>)(
      params,
    );

/** One counter per case, reset when that case's mock is installed. */
const attemptCounter = () => {
  let attempts = 0;
  return {
    record: () => {
      attempts += 1;
    },
    read: () => attempts,
    reset: () => {
      attempts = 0;
    },
  };
};

/** A mocked SDK client, with the failing call wired to the case's counter. */
type ClientShape = (fail: () => never) => {
  chat?: unknown;
  messages?: unknown;
};

const chatCompletionsClient: ClientShape = (fail) => ({
  chat: { completions: { create: vi.fn(fail) } },
});

const anthropicMessagesClient: ClientShape = (fail) => ({
  messages: { create: vi.fn(fail) },
});

/**
 * A provider whose SDK arrives as a module import, so its client is mocked. The
 * mock offers the OpenAI, Azure and Groq client constructors from one class, so
 * a case only has to say which module to mock and where its call lives.
 */
const sdkCase = ({
  label,
  module,
  buildClient,
  load,
  functionName,
  extraParams = {},
}: {
  label: string;
  module: string;
  buildClient: ClientShape;
  load: () => Promise<Module>;
  functionName: string;
  extraParams?: Record<string, unknown>;
}): ProviderCase => {
  const counter = attemptCounter();
  return {
    label,
    attempts: counter.read,
    mock: (fail) => {
      counter.reset();
      const client = buildClient(() => {
        counter.record();
        return fail();
      });
      const MockClient = class {
        chat = client.chat;
        messages = client.messages;
      };
      vi.doMock(module, () => ({
        default: MockClient,
        AzureOpenAI: MockClient,
        toFile: vi.fn(),
      }));
    },
    unmock: () => {
      vi.doUnmock(module);
    },
    load,
    run: (mod, signal) =>
      invoke(
        mod,
        functionName,
      )({
        apiKey: "test-key",
        prompt: "hi",
        ...extraParams,
        signal,
      }),
  };
};

/** Gemini talks to fetch directly, so its attempt count is the fetch count. */
const geminiCase = (
  label: string,
  functionName: string,
  extraParams: Record<string, unknown>,
): ProviderCase => {
  const counter = attemptCounter();
  return {
    label,
    attempts: counter.read,
    // Gemini needs no module mock, so there is nothing to install or unmock.
    mock: () => counter.reset(),
    unmock: () => undefined,
    load: async () => import("../src/gemini.utils"),
    run: (mod, signal) =>
      invoke(
        mod,
        functionName,
      )({
        apiKey: "test-key",
        signal,
        ...extraParams,
        customFetch: async () => {
          counter.record();
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "60" },
          });
        },
      }),
  };
};

/**
 * Every provider that already holds an abort signal has to hand it to the
 * shared helper, otherwise the wait after a rate limit cannot be cancelled and
 * a caller who has given up still sits out the server's instruction. Nothing
 * else about the request changes: an abort that lands during a wait rejects
 * with the caller's own reason rather than the original transient failure, and
 * no doomed second attempt is sent.
 */
const providerCases: ProviderCase[] = [
  sdkCase({
    label: "openaiGenerateTextResponse",
    module: "openai",
    buildClient: chatCompletionsClient,
    load: async () => import("../src/openai.utils"),
    functionName: "openaiGenerateTextResponse",
  }),
  sdkCase({
    label: "deepseekGenerateTextResponse",
    module: "openai",
    buildClient: chatCompletionsClient,
    load: async () => import("../src/deepseek.utils"),
    functionName: "deepseekGenerateTextResponse",
  }),
  sdkCase({
    label: "cerebrasGenerateTextResponse",
    module: "openai",
    buildClient: chatCompletionsClient,
    load: async () => import("../src/cerebras.utils"),
    functionName: "cerebrasGenerateTextResponse",
  }),
  sdkCase({
    label: "openrouterGenerateTextResponse",
    module: "openai",
    buildClient: chatCompletionsClient,
    load: async () => import("../src/openrouter.utils"),
    functionName: "openrouterGenerateTextResponse",
  }),
  sdkCase({
    label: "azureOpenAIGenerateText",
    module: "openai",
    buildClient: chatCompletionsClient,
    load: async () => import("../src/azure-openai.utils"),
    functionName: "azureOpenAIGenerateText",
    extraParams: {
      endpoint: "https://test.azure.com",
      deploymentName: "gpt-4o-mini",
    },
  }),
  sdkCase({
    label: "groqGenerateTextResponse",
    module: "groq-sdk/index",
    buildClient: chatCompletionsClient,
    load: async () => import("../src/groq.utils"),
    functionName: "groqGenerateTextResponse",
  }),
  sdkCase({
    label: "claudeGenerateTextResponse",
    module: "@anthropic-ai/sdk",
    buildClient: anthropicMessagesClient,
    load: async () => import("../src/claude.utils"),
    functionName: "claudeGenerateTextResponse",
  }),
  geminiCase("geminiGenerateTextResponse", "geminiGenerateTextResponse", {
    prompt: "hi",
  }),
  geminiCase("geminiTranscribeAudio", "geminiTranscribeAudio", {
    blob: audio,
  }),
];

describe("a caller's abort signal ends the retry wait", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it.each(providerCases)(
    "$label rejects with the caller's reason and sends no second attempt",
    async ({ mock, unmock, load, run, attempts }) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const reason = new Error("caller gave up");

      mock(() => {
        throw rateLimited();
      });
      const mod = await load();
      let settled: unknown = null;
      void run(mod, controller.signal).then(
        () => {
          settled = "resolved";
        },
        (error: unknown) => {
          settled = error;
        },
      );

      // The first attempt has failed and the helper is inside the wait the 60
      // second hint asked for.
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts()).toBe(1);
      expect(settled).toBeNull();

      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(reason);
      expect(attempts()).toBe(1);
      unmock();
    },
  );
});

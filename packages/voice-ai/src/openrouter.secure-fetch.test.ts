import { describe, expect, it, vi } from "vitest";
import type { CustomFetch } from "./types";

/**
 * Every OpenRouter entry point must build its client with the caller's fetch.
 *
 * The desktop app wires each provider with its own native or secure request
 * path, and that wrapper is what redacts the key out of a gateway echo and
 * refuses a host the user never configured. An entry point that leaves
 * `customFetch` out does not fall back to anything safe: the SDK silently uses
 * the runtime's global `fetch`, so the request leaves the app unredacted and
 * unvalidated while every test, which injects its own mock, still passes. The
 * assertion is therefore on the constructor's own options, read off the client
 * each path built, rather than on a request the mock happened to answer.
 */
describe("openrouter production paths thread the caller's fetch", () => {
  /** The options each constructed client was given, so the fetch can be read. */
  const clientOptionsSeenRaw = vi.hoisted(() => vi.fn());
  /**
   * The uploads `toFile` calls, so a mock of that module can be shown to be the
   * one running rather than assumed to be.
   *
   * `openrouterTranscribeAudio` delegates to `openaiCompatibleTranscribeAudio`,
   * which takes `toFile` from `"openai/uploads"` and not from the bare `"openai"`
   * module. A `toFile` on the `"openai"` mock is therefore never called by the
   * transcription path, which left the test running the real SDK's `toFile`
   * against a bare `ArrayBuffer` while appearing to stub it.
   */
  const uploadCallsRaw = vi.hoisted(() => vi.fn());

  const setupOpenAIMock = (
    completion: () => unknown = () => ({
      choices: [{ message: { content: "ok" } }],
      usage: { total_tokens: 5 },
    }),
  ) => {
    vi.resetModules();
    clientOptionsSeenRaw.mockClear();
    uploadCallsRaw.mockClear();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        constructor(options: Record<string, unknown>) {
          clientOptionsSeenRaw(options);
        }
        audio = {
          transcriptions: {
            create: vi.fn().mockResolvedValue({ text: "hello world" }),
          },
        };
        chat = {
          completions: { create: vi.fn().mockImplementation(completion) },
        };
        models = { list: vi.fn().mockResolvedValue({ data: [] }) };
      },
    }));
    vi.doMock("openai/uploads", () => ({
      toFile: vi.fn().mockImplementation((...args: unknown[]) => {
        uploadCallsRaw(...args);
        return Promise.resolve({});
      }),
    }));
  };

  /** A one-chunk completion stream, which is all the adapter reads. */
  const sseChunk = async function* () {
    yield {
      choices: [{ delta: { content: "ok" } }],
      model: "openai/gpt-oss-20b",
    };
  };

  const clientOptionsSeen = (): Array<Record<string, unknown>> =>
    clientOptionsSeenRaw.mock.calls.map(([options]) => options);

  const loadOpenRouter = async () => {
    const mod = await import("./openrouter.utils");
    vi.doUnmock("openai");
    return mod;
  };

  type OpenRouterModule = Awaited<ReturnType<typeof loadOpenRouter>>;

  /**
   * The call under test, in the shape both helpers below want: the freshly
   * imported module and the caller's fetch. Passing the entry point in rather
   * than repeating it per test is what keeps a new entry point from arriving as
   * another copy of this file's mock-and-assert block.
   */
  type EntryUnderTest = (
    module: OpenRouterModule,
    customFetch: CustomFetch,
  ) => Promise<unknown>;

  /** Runs `entry` and asserts the client it built was given that fetch. */
  const expectClientBuiltWithCallerFetch = async (
    entry: EntryUnderTest,
    completion?: () => unknown,
  ): Promise<void> => {
    setupOpenAIMock(completion);
    const customFetch: CustomFetch = vi.fn();

    await entry(await loadOpenRouter(), customFetch);

    const [clientOptions] = clientOptionsSeen();
    expect(clientOptions).toBeDefined();
    expect(clientOptions?.fetch).toBe(customFetch);
  };

  /**
   * The same for the two entry points that do not go through the SDK, so there
   * is no constructor to read. What matters is the same either way: the caller's
   * instance is the one that makes the request, not the global it would
   * otherwise fall back to. The mock answers a catalog-shaped body so a path that
   * parsed it differently would raise rather than pass vacuously.
   */
  const expectFetchedOverCallerFetch = async (
    entry: EntryUnderTest,
  ): Promise<void> => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await entry(await loadOpenRouter(), customFetch as CustomFetch);

    expect(customFetch).toHaveBeenCalledTimes(1);
  };

  it("builds the transcription client with the caller's fetch", async () => {
    const blob = new ArrayBuffer(8);
    await expectClientBuiltWithCallerFetch(
      async ({ openrouterTranscribeAudio }, customFetch) => {
        await openrouterTranscribeAudio({
          apiKey: "test-key",
          model: "openai/whisper-large-v3",
          blob,
          ext: "wav",
          customFetch,
        });
      },
    );

    // The uploads module is the one the transcription path imports `toFile`
    // from, so this asserts the stub is the code under test rather than leaving
    // it to be believed. A mock of the bare `"openai"` module cannot see this
    // call, which is what made the previous version of this test vacuous.
    expect(uploadCallsRaw).toHaveBeenCalledTimes(1);
    expect(uploadCallsRaw.mock.calls[0]?.[0]).toBe(blob);
  });

  it("builds the generate-text client with the caller's fetch", async () => {
    await expectClientBuiltWithCallerFetch(
      async ({ openrouterGenerateTextResponse }, customFetch) => {
        await openrouterGenerateTextResponse({
          apiKey: "test-key",
          prompt: "hi",
          customFetch,
        });
      },
    );
  });

  it("builds the integration-probe client with the caller's fetch", async () => {
    await expectClientBuiltWithCallerFetch(
      async ({ openrouterTestIntegration }, customFetch) => {
        await openrouterTestIntegration({ apiKey: "test-key", customFetch });
      },
    );
  });

  it("builds the stream-chat client with the caller's fetch", async () => {
    await expectClientBuiltWithCallerFetch(
      async ({ openrouterStreamChat }, customFetch) => {
        for await (const _event of openrouterStreamChat({
          apiKey: "test-key",
          model: "openai/gpt-oss-20b",
          input: { messages: [{ role: "user", content: "Hello" }] },
          customFetch,
        })) {
          // drain
        }
      },
      () => sseChunk(),
    );
  });

  it("fetches the model catalog over the caller's fetch", async () => {
    await expectFetchedOverCallerFetch(
      async ({ openrouterFetchModels }, customFetch) => {
        await openrouterFetchModels({ apiKey: "test-key", customFetch });
      },
    );
  });

  it("fetches the provider catalog over the caller's fetch", async () => {
    await expectFetchedOverCallerFetch(
      async ({ openrouterFetchProviders }, customFetch) => {
        await openrouterFetchProviders({ customFetch });
      },
    );
  });
});

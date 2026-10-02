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

  const setupOpenAIMock = (
    completion: () => unknown = () => ({
      choices: [{ message: { content: "ok" } }],
      usage: { total_tokens: 5 },
    }),
  ) => {
    vi.resetModules();
    clientOptionsSeenRaw.mockClear();
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
      toFile: vi.fn().mockResolvedValue({}),
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

  it("builds the transcription client with the caller's fetch", async () => {
    setupOpenAIMock();
    const customFetch: CustomFetch = vi.fn();

    const { openrouterTranscribeAudio } = await loadOpenRouter();
    await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-large-v3",
      blob: new ArrayBuffer(8),
      ext: "wav",
      customFetch,
    });

    const [clientOptions] = clientOptionsSeen();
    expect(clientOptions.fetch).toBe(customFetch);
  });

  it("builds the generate-text client with the caller's fetch", async () => {
    setupOpenAIMock();
    const customFetch: CustomFetch = vi.fn();

    const { openrouterGenerateTextResponse } = await loadOpenRouter();
    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hi",
      customFetch,
    });

    const [clientOptions] = clientOptionsSeen();
    expect(clientOptions.fetch).toBe(customFetch);
  });

  it("builds the integration-probe client with the caller's fetch", async () => {
    setupOpenAIMock();
    const customFetch: CustomFetch = vi.fn();

    const { openrouterTestIntegration } = await loadOpenRouter();
    await openrouterTestIntegration({ apiKey: "test-key", customFetch });

    const [clientOptions] = clientOptionsSeen();
    expect(clientOptions.fetch).toBe(customFetch);
  });

  it("builds the stream-chat client with the caller's fetch", async () => {
    setupOpenAIMock(() => sseChunk());
    const customFetch: CustomFetch = vi.fn();

    const { openrouterStreamChat } = await loadOpenRouter();
    for await (const _event of openrouterStreamChat({
      apiKey: "test-key",
      model: "openai/gpt-oss-20b",
      input: { messages: [{ role: "user", content: "Hello" }] },
      customFetch,
    })) {
      // drain
    }

    const [clientOptions] = clientOptionsSeen();
    expect(clientOptions.fetch).toBe(customFetch);
  });

  // These two do not go through the SDK, so there is no constructor to read.
  // What matters is the same either way: the caller's instance is the one that
  // makes the request, not the global it would otherwise fall back to.
  it("fetches the model catalog over the caller's fetch", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { openrouterFetchModels } = await loadOpenRouter();
    await openrouterFetchModels({ apiKey: "test-key", customFetch });

    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches the provider catalog over the caller's fetch", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { openrouterFetchProviders } = await loadOpenRouter();
    await openrouterFetchProviders({ customFetch });

    expect(customFetch).toHaveBeenCalledTimes(1);
  });
});

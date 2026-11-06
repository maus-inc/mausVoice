import { beforeEach, describe, expect, it, vi } from "vitest";

// The redaction rules key on the provider prefix, so the fixture is realistic in the value it produces; it is assembled from two parts so that a secret scanner reading this repository does not report a live key.
const GROQ_KEY = "gsk" + "_test";

const { invokeMock, loggerVerboseMock, pluginFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  loggerVerboseMock: vi.fn(),
  pluginFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: pluginFetchMock }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: loggerVerboseMock }),
}));

import {
  AzureModelProviderRepo,
  ClaudeModelProviderRepo,
  GeminiModelProviderRepo,
  GroqModelProviderRepo,
  OpenAICompatibleModelProviderRepo,
  OpenAIModelProviderRepo,
  OpenRouterModelProviderRepo,
  OllamaModelProviderRepo,
  SpeachesModelProviderRepo,
  XaiModelProviderRepo,
} from "./model-provider.repo";

describe("provider model discovery", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loggerVerboseMock.mockReset();
    pluginFetchMock.mockReset();
  });

  /**
   * The headers of one request to plugin-http, as a plain object. `secureFetch`
   * walks a redirect chain a hop at a time and rewrites the headers per hop, so
   * a hop is handed a `Headers` rather than the caller's own object: the names
   * arrive lower-cased, as the fetch standard lower-cases them, and the
   * assertions below read the content rather than the container.
   */
  const sentHeaders = (call: number): Record<string, string> =>
    Object.fromEntries(
      new Headers(
        (pluginFetchMock.mock.calls[call]?.[1] as RequestInit | undefined)
          ?.headers,
      ).entries(),
    );

  it("uses Groq's live model catalog instead of a hard-coded LLM list", async () => {
    pluginFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "future-provider/model-v2" },
              { id: "whisper-large-v3-turbo" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const repo = new GroqModelProviderRepo();
    const options = { apiKey: GROQ_KEY };

    await expect(repo.getGenerativeTextModels(options)).resolves.toEqual([
      "future-provider/model-v2",
    ]);
    await expect(repo.getTranscriptionModels(options)).resolves.toEqual([
      "whisper-large-v3-turbo",
    ]);
    expect(pluginFetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(sentHeaders(0)).toMatchObject({
      authorization: `Bearer ${GROQ_KEY}`,
    });
  });

  it("accepts current Gemini text models while excluding specialized catalogs", async () => {
    pluginFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-future-flash",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-future-flash-image",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-embedding-future",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          }),
        ),
      ),
    );
    const repo = new GeminiModelProviderRepo();

    await expect(
      repo.getGenerativeTextModels({ apiKey: "gemini-key" }),
    ).resolves.toEqual(["gemini-future-flash"]);
    await expect(
      repo.getTranscriptionModels({ apiKey: "gemini-key" }),
    ).resolves.toEqual(["gemini-future-flash"]);
    expect(pluginFetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      expect.objectContaining({ method: "GET" }),
    );
    expect(sentHeaders(0)).toMatchObject({ "x-goog-api-key": "gemini-key" });
  });

  it("includes dedicated transcribe model for transcription but not for generation", async () => {
    pluginFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-3.5-transcribe",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-3.5-transcribe-live",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-3.8-flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
        ),
      ),
    );
    const repo = new GeminiModelProviderRepo();

    await expect(
      repo.getGenerativeTextModels({ apiKey: "gemini-key" }),
    ).resolves.toEqual(["gemini-3.8-flash"]);
    await expect(
      repo.getTranscriptionModels({ apiKey: "gemini-key" }),
    ).resolves.toEqual(["gemini-3.5-transcribe", "gemini-3.8-flash"]);
  });

  it("separates OpenAI chat and file-transcription models", async () => {
    pluginFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-5.7-luna" },
              { id: "gpt-image-2" },
              { id: "gpt-live-transcribe" },
              { id: "whisper-1" },
            ],
          }),
        ),
      ),
    );
    const repo = new OpenAIModelProviderRepo();

    await expect(
      repo.getGenerativeTextModels({ apiKey: "openai-key" }),
    ).resolves.toEqual(["gpt-5.7-luna"]);
    await expect(
      repo.getTranscriptionModels({ apiKey: "openai-key" }),
    ).resolves.toEqual(["whisper-1"]);
  });

  it("loads OpenRouter's STT-only catalog for its transcription picker", async () => {
    pluginFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "openai/whisper-large-v3" }, { id: "openai/whisper-1" }],
        }),
        { status: 200 },
      ),
    );

    await expect(
      new OpenRouterModelProviderRepo().getTranscriptionModels({
        apiKey: "openrouter-key",
      }),
    ).resolves.toEqual(["openai/whisper-1", "openai/whisper-large-v3"]);
    expect(pluginFetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models?output_modalities=transcription",
      expect.objectContaining({ method: "GET" }),
    );
    expect(sentHeaders(0)).toMatchObject({
      authorization: "Bearer openrouter-key",
    });
  });

  it.each([
    ["Gemini", () => new GeminiModelProviderRepo(), "generative"],
    ["OpenAI", () => new OpenAIModelProviderRepo(), "generative"],
    ["Azure", () => new AzureModelProviderRepo(), "generative"],
    ["Ollama", () => new OllamaModelProviderRepo(), "generative"],
    ["Speaches", () => new SpeachesModelProviderRepo(), "transcription"],
  ] as const)(
    "%s discards an unused error body during discovery",
    async (_provider, build, kind) => {
      const response = new Response("private diagnostic", { status: 503 });
      const cancel = vi
        .spyOn(response.body!, "cancel")
        .mockReturnValue(new Promise(() => {}));
      pluginFetchMock.mockResolvedValue(response);
      const repo = build();
      const options = { apiKey: "key", baseUrl: "https://endpoint.example" };
      if (kind === "generative") await repo.getGenerativeTextModels(options);
      else await repo.getTranscriptionModels(options);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("logs provider HTTP failures before using a fallback catalog", async () => {
    pluginFetchMock.mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    );

    const mockGeminiKey = ["mock", "gemini", "key"].join("-");
    await expect(
      new GeminiModelProviderRepo().getGenerativeTextModels({
        apiKey: mockGeminiKey,
      }),
    ).resolves.not.toEqual([]);
    expect(loggerVerboseMock).toHaveBeenCalledWith(
      "Gemini model discovery failed (HTTP 401)",
    );
    expect(JSON.stringify(loggerVerboseMock.mock.calls)).not.toContain(
      mockGeminiKey,
    );
  });

  it.each([
    ["Gemini", () => new GeminiModelProviderRepo(), "x-goog-api-key"],
    ["Claude", () => new ClaudeModelProviderRepo(), "x-api-key"],
    ["Azure", () => new AzureModelProviderRepo(), "api-key"],
  ])(
    "%s model discovery does not forward credentials to a redirect origin",
    async (_provider, repo, header) => {
      const receivedHeaders: Record<string, string>[] = [];
      const responses = [
        new Response(null, {
          status: 307,
          headers: { location: "https://other-provider.example/models" },
        }),
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ];
      pluginFetchMock.mockImplementation((_url: string, init: RequestInit) => {
        receivedHeaders.push(
          Object.fromEntries(new Headers(init.headers).entries()),
        );
        return Promise.resolve(responses.shift());
      });
      const secret = "credential-only-for-first-provider";
      await repo().getGenerativeTextModels({
        apiKey: secret,
        baseUrl: "https://azure.example",
      });
      expect(receivedHeaders).toHaveLength(2);
      expect(receivedHeaders[0][header]).toBe(secret);
      expect(receivedHeaders[1]).not.toHaveProperty(header);
    },
  );

  it.each([
    ["Ollama", () => new OllamaModelProviderRepo(), "generative"],
    ["Speaches", () => new SpeachesModelProviderRepo(), "transcription"],
  ])("%s does not expose a malformed endpoint", async (_name, build, kind) => {
    const secret = "private-endpoint-value";
    const repo = build();
    const options = { baseUrl: `https://user:${secret}@[invalid` };
    const request =
      kind === "generative"
        ? repo.getGenerativeTextModels(options)
        : repo.getTranscriptionModels(options);
    const error = await request.then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it.each([
    ["Azure", () => new AzureModelProviderRepo(), "generative"],
    ["Ollama", () => new OllamaModelProviderRepo(), "generative"],
    ["Speaches", () => new SpeachesModelProviderRepo(), "transcription"],
    [
      "OpenAI-compatible",
      () => new OpenAICompatibleModelProviderRepo(),
      "generative",
    ],
  ])(
    "%s hides transport errors in model discovery",
    async (_name, build, kind) => {
      const secret = "transport-private-fragment";
      pluginFetchMock.mockRejectedValue(new Error(secret));
      invokeMock.mockRejectedValue(new Error(secret));
      const repo = build();
      const options = {
        baseUrl: "https://provider.example",
        apiKey: "test-key",
        apiKeyId: "saved-key",
      };
      const request =
        kind === "generative"
          ? repo.getGenerativeTextModels(options)
          : repo.getTranscriptionModels(options);
      const error = await request.then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(_name);
      expect(String(error)).toContain("model discovery request failed");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    },
  );

  it.each([
    ["Azure", () => new AzureModelProviderRepo(), "generative"],
    ["Ollama", () => new OllamaModelProviderRepo(), "generative"],
    ["Speaches", () => new SpeachesModelProviderRepo(), "transcription"],
    [
      "OpenAI-compatible",
      () => new OpenAICompatibleModelProviderRepo(),
      "generative",
    ],
  ])(
    "%s does not leak malformed model response fragments",
    async (_name, build, kind) => {
      const secret = "s3cr3t";
      pluginFetchMock.mockResolvedValue(new Response(secret, { status: 200 }));
      invokeMock.mockResolvedValue({
        status: 200,
        headers: {},
        bodyBase64: btoa(secret),
      });
      const repo = build();
      const options = {
        baseUrl: "https://provider.example",
        apiKey: "test-key",
        apiKeyId: "saved-key",
      };
      const request =
        kind === "generative"
          ? repo.getGenerativeTextModels(options)
          : repo.getTranscriptionModels(options);
      const error = await request.then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(_name);
      expect(String(error)).toContain("model discovery returned invalid JSON");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    },
  );

  it.each([
    [
      "Azure",
      () => new AzureModelProviderRepo(),
      "generative",
      "/openai/models?api-version=2024-10-21",
      { data: [{ id: "latest-model" }] },
    ],
    [
      "Ollama",
      () => new OllamaModelProviderRepo(),
      "generative",
      "/api/tags",
      { models: [{ name: "latest-model" }] },
    ],
    [
      "Speaches",
      () => new SpeachesModelProviderRepo(),
      "transcription",
      "/v1/models",
      { data: [{ id: "latest-model" }] },
    ],
  ])(
    "%s preserves successful catalog requests",
    async (_name, build, kind, path, payload) => {
      pluginFetchMock.mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      const repo = build();
      const options = {
        baseUrl: "https://provider.example",
        apiKey: "test-key",
      };
      const models =
        kind === "generative"
          ? await repo.getGenerativeTextModels(options)
          : await repo.getTranscriptionModels(options);
      expect(models).toEqual(["latest-model"]);
      expect(pluginFetchMock.mock.calls[0][0]).toBe(
        `https://provider.example${path}`,
      );
    },
  );

  it("never logs a provider-controlled HTTP reason phrase", async () => {
    const secret = ["private", "credential", "fragment"].join("-");
    pluginFetchMock.mockResolvedValue(
      new Response(null, { status: 401, statusText: `failure ${secret}` }),
    );

    await new GeminiModelProviderRepo().getGenerativeTextModels({
      apiKey: secret,
    });
    expect(loggerVerboseMock).toHaveBeenCalledWith(
      "Gemini model discovery failed (HTTP 401)",
    );
    expect(JSON.stringify(loggerVerboseMock.mock.calls)).not.toContain(secret);
  });

  it("logs caught discovery errors without leaking transport details", async () => {
    const mockOpenAiKey = ["mock", "openai", "key"].join("-");
    pluginFetchMock.mockRejectedValue(
      new Error(`socket failed at a URL containing ${mockOpenAiKey}`),
    );

    await expect(
      new OpenAIModelProviderRepo().getGenerativeTextModels({
        apiKey: mockOpenAiKey,
      }),
    ).resolves.not.toEqual([]);
    expect(loggerVerboseMock).toHaveBeenCalledWith(
      "OpenAI model discovery failed (request or response parsing failed)",
    );
    expect(JSON.stringify(loggerVerboseMock.mock.calls)).not.toContain(
      mockOpenAiKey,
    );
  });

  it("does not show a fake model selector for xAI's dedicated STT route", async () => {
    await expect(
      new XaiModelProviderRepo().getTranscriptionModels(),
    ).resolves.toEqual([]);
  });

  it("uses shared isGeminiTranscribeModel predicate for dedicated detection", async () => {
    // Table-driven: transcribe vs live-transcribe disagreement (finding 6)
    const { isGeminiTranscribeModel } = await import("@maus-inc/voice-ai");
    const cases: Array<[string, boolean]> = [
      ["gemini-3.5-transcribe", true],
      ["gemini-3.5-transcribe-live", false],
      ["gemini-2.5-flash", false],
      ["gemini-3.8-flash", false],
    ];
    for (const [model, expected] of cases) {
      expect(isGeminiTranscribeModel(model)).toBe(expected);
    }
  });

  it("fetches a saved custom catalog while preserving its path prefix", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: btoa(
        JSON.stringify({ data: [{ id: "custom/latest-model" }] }),
      ),
    });
    const repo = new OpenAICompatibleModelProviderRepo();

    await expect(
      repo.getGenerativeTextModels({
        apiKeyId: "custom-key-id",
        apiKey: "secret",
        baseUrl: "https://llm.example.com/proxy/openai",
        includeV1Path: true,
      }),
    ).resolves.toEqual(["custom/latest-model"]);
    expect(invokeMock).toHaveBeenCalledWith(
      "openai_compatible_http_request",
      expect.objectContaining({
        apiKeyId: "custom-key-id",
        request: expect.objectContaining({
          url: "https://llm.example.com/proxy/openai/v1/models",
        }),
      }),
    );
  });
});

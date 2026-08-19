import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, pluginFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  pluginFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: pluginFetchMock }));

import {
  GeminiModelProviderRepo,
  GroqModelProviderRepo,
  OpenAICompatibleModelProviderRepo,
  OpenAIModelProviderRepo,
  XaiModelProviderRepo,
} from "./model-provider.repo";

describe("provider model discovery", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    pluginFetchMock.mockReset();
  });

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
    const options = { apiKey: "gsk_test" };

    await expect(repo.getGenerativeTextModels(options)).resolves.toEqual([
      "future-provider/model-v2",
    ]);
    await expect(repo.getTranscriptionModels(options)).resolves.toEqual([
      "whisper-large-v3-turbo",
    ]);
    expect(pluginFetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer gsk_test" },
      }),
    );
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
              { id: "gpt-transcribe" },
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
    ).resolves.toEqual(["gpt-transcribe"]);
  });

  it("does not show a fake model selector for xAI's dedicated STT route", async () => {
    await expect(
      new XaiModelProviderRepo().getTranscriptionModels(),
    ).resolves.toEqual([]);
  });

  it("fetches a saved custom catalog while preserving its path prefix", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Array.from(
        new TextEncoder().encode(
          JSON.stringify({ data: [{ id: "custom/latest-model" }] }),
        ),
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

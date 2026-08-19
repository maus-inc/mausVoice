import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, pluginFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  pluginFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: pluginFetchMock }));

import {
  GroqModelProviderRepo,
  OpenAICompatibleModelProviderRepo,
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

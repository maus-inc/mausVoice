import { describe, expect, it, vi } from "vitest";

const { clientOptions, listModels } = vi.hoisted(() => ({
  clientOptions: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ data: [{ id: "gpt-oss-120b" }] }),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    models = { list: listModels };

    constructor(options: unknown) {
      clientOptions(options);
    }
  },
}));

import { CEREBRAS_MODELS, cerebrasTestIntegration } from "./cerebras.utils";

describe("Cerebras provider", () => {
  it("uses the current public models as offline fallbacks", () => {
    expect(CEREBRAS_MODELS).toEqual(["gpt-oss-120b", "gemma-4-31b"]);
  });

  it("tests credentials by listing live models instead of calling a stale fixed model", async () => {
    const customFetch = vi.fn();

    await expect(
      cerebrasTestIntegration({ apiKey: " csk_test ", customFetch }),
    ).resolves.toBe(true);
    expect(listModels).toHaveBeenCalledOnce();
    expect(clientOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "csk_test",
        baseURL: "https://api.cerebras.ai/v1",
        fetch: customFetch,
      }),
    );
  });
});

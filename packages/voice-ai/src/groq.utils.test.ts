import { beforeEach, describe, expect, it, vi } from "vitest";

const { createChatCompletion } = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("groq-sdk/index", () => ({
  default: class MockGroq {
    chat = { completions: { create: createChatCompletion } };
  },
}));

import { groqGenerateTextResponse } from "./groq.utils";

const completion = {
  choices: [{ message: { content: '{"result":"ok"}' } }],
  usage: { total_tokens: 3 },
};

describe("groqGenerateTextResponse request body", () => {
  beforeEach(() => {
    createChatCompletion.mockReset();
    createChatCompletion.mockResolvedValue(completion);
  });

  it("forwards the output budget and reasoning effort for gpt-oss", async () => {
    await groqGenerateTextResponse({
      apiKey: "gsk_test",
      model: "openai/gpt-oss-20b",
      prompt: "p",
      maxTokens: 3000,
      reasoningEffort: "low",
    });

    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        max_completion_tokens: 3000,
        reasoning_effort: "low",
      }),
      expect.anything(),
    );
  });

  it("omits the effort for the Qwen fallback model", async () => {
    await groqGenerateTextResponse({
      apiKey: "gsk_test",
      model: "qwen/qwen3.6-27b",
      prompt: "p",
      reasoningEffort: "low",
    });

    const [body] = createChatCompletion.mock.calls[0] ?? [];
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

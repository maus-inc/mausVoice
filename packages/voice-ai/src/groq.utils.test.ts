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

  it("omits the effort for a non-gpt-oss Groq model", async () => {
    await groqGenerateTextResponse({
      apiKey: "gsk_test",
      model: "custom/model-without-reasoning-effort",
      prompt: "p",
      reasoningEffort: "low",
    });

    const [body] = createChatCompletion.mock.calls[0] ?? [];
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("groqGenerateTextResponse retries", () => {
  beforeEach(() => {
    createChatCompletion.mockReset();
  });

  const reject = (status: number) =>
    Object.assign(new Error(`status ${status}`), { status });

  it.each([401, 402, 403])(
    "does not retry a rejected key (%i)",
    async (status) => {
      createChatCompletion.mockRejectedValue(reject(status));

      await expect(
        groqGenerateTextResponse({
          apiKey: "gsk_test",
          model: "openai/gpt-oss-20b",
          prompt: "p",
        }),
      ).rejects.toMatchObject({ status });
      expect(createChatCompletion).toHaveBeenCalledTimes(1);
    },
  );

  it("still retries a transient failure", async () => {
    createChatCompletion
      .mockRejectedValueOnce(reject(503))
      .mockResolvedValueOnce(completion);

    await groqGenerateTextResponse({
      apiKey: "gsk_test",
      model: "openai/gpt-oss-20b",
      prompt: "p",
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
});

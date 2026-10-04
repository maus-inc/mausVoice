import { beforeEach, describe, expect, it, vi } from "vitest";

const { createChatCompletion } = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("groq-sdk/index", () => ({
  default: class MockGroq {
    chat = { completions: { create: createChatCompletion } };
  },
}));

import {
  groqGenerateTextResponse,
  isGroqAccountScopedError,
  isGroqPermanentRequestError,
} from "./groq.utils";

// The redaction rules key on the provider prefix, so the fixture is realistic in the value it produces; it is assembled from two parts so that a secret scanner reading this repository does not report a live key.
const GROQ_KEY = "gsk" + "_test";

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
      apiKey: GROQ_KEY,
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
      apiKey: GROQ_KEY,
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

  it.each([401, 402])("does not retry a rejected key (%i)", async (status) => {
    createChatCompletion.mockRejectedValue(reject(status));

    await expect(
      groqGenerateTextResponse({
        apiKey: GROQ_KEY,
        model: "openai/gpt-oss-20b",
        prompt: "p",
      }),
    ).rejects.toMatchObject({ status });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  // This case was misnamed and misasserted. There is NO model-fallback loop in
  // `groqGenerateTextResponse` -- the only `.map` in it is over `imageUrls` -- so the
  // `toBeGreaterThan(1)` this replaced was counting `retry()` re-sending the SAME request to
  // the SAME deployment. A 403 is an organisation-level refusal (the research recorded above
  // the set in the source is why), so those two extra requests could not succeed and the
  // measured cost was three chargeable calls per failure.
  //
  // The two halves are now asserted separately, because they are separate decisions:
  //   * do NOT retry it                      -> exactly one call
  //   * do NOT treat it as account-scoped    -> the fallback chain above still gets its turn
  // Conflating them is what let the retry happen: the only test covering 403 asserted the
  // retry, and the only thing keeping the chain reachable was a predicate nothing checked.
  it.each([403, 422])(
    "sends a permanent %i exactly once, and leaves it out of the account-scoped set",
    async (status) => {
      createChatCompletion.mockRejectedValue(reject(status));

      await expect(
        groqGenerateTextResponse({
          apiKey: GROQ_KEY,
          model: "openai/gpt-oss-20b",
          prompt: "p",
        }),
      ).rejects.toMatchObject({ status });

      // Half one: the same request is not re-sent. Without this the retry loop is back.
      expect(createChatCompletion).toHaveBeenCalledTimes(1);
      // Half two: and it is NOT account-scoped, so whatever consults that set still tries the
      // next model. Asserted explicitly because nothing else in this file covers the 403.
      expect(isGroqAccountScopedError(reject(status))).toBe(false);
      expect(isGroqPermanentRequestError(reject(status))).toBe(true);
    },
  );

  // The control for the pair above: a transient failure must still be retried, or the
  // permanent cases would pass for the wrong reason.
  it("still retries a status that can clear", async () => {
    createChatCompletion.mockRejectedValue(reject(503));

    await expect(
      groqGenerateTextResponse({
        apiKey: GROQ_KEY,
        model: "openai/gpt-oss-20b",
        prompt: "p",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(createChatCompletion.mock.calls.length).toBeGreaterThan(1);
    expect(isGroqPermanentRequestError(reject(503))).toBe(false);
  });

  it("still retries a transient failure", async () => {
    createChatCompletion
      .mockRejectedValueOnce(reject(503))
      .mockResolvedValueOnce(completion);

    await groqGenerateTextResponse({
      apiKey: GROQ_KEY,
      model: "openai/gpt-oss-20b",
      prompt: "p",
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
});

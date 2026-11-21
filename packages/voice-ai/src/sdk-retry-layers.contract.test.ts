import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { azureOpenAIGenerateText } from "./azure-openai.utils";
import { cerebrasGenerateTextResponse } from "./cerebras.utils";
import { claudeGenerateTextResponse } from "./claude.utils";
import { deepseekGenerateTextResponse } from "./deepseek.utils";
import { groqGenerateTextResponse, groqStreamChat } from "./groq.utils";
import { openaiGenerateTextResponse } from "./openai.utils";
import { openrouterGenerateTextResponse } from "./openrouter.utils";
import type { CustomFetch } from "./types";

type Args = { apiKey: string; prompt: string; customFetch: CustomFetch };
const clients: Record<string, (args: Args) => Promise<unknown>> = {
  OpenAI: openaiGenerateTextResponse,
  Azure: (args) =>
    azureOpenAIGenerateText({
      ...args,
      endpoint: "https://azure.invalid",
      deploymentName: "chat",
    }),
  Cerebras: cerebrasGenerateTextResponse,
  Claude: claudeGenerateTextResponse,
  DeepSeek: deepseekGenerateTextResponse,
  Groq: groqGenerateTextResponse,
  OpenRouter: openrouterGenerateTextResponse,
};

const transport = (status: number) =>
  vi.fn(async () =>
    Response.json(
      { error: { message: "fixture failure" } },
      { status, headers: { "retry-after-ms": "1" } },
    ),
  );

describe("wire attempts through the installed SDKs", () => {
  beforeEach(() =>
    vi.stubGlobal("fetch", () => {
      throw new Error("unexpected network transport");
    }),
  );
  afterEach(() => vi.unstubAllGlobals());

  describe.each(Object.entries(clients))("%s", (_name, generate) => {
    it.each([
      [500, 3],
      [429, 3],
      [401, 1],
    ])("HTTP %i issues %i requests", async (status, count) => {
      const customFetch = transport(status);
      await expect(
        generate({ apiKey: "fixture", prompt: "hello", customFetch }),
      ).rejects.toThrow();
      expect(customFetch).toHaveBeenCalledTimes(count);
    });
  });

  it("does not replay the separate Groq streaming client on a 500", async () => {
    const customFetch = transport(500);
    const stream = groqStreamChat({
      apiKey: "fixture",
      model: "test",
      input: { messages: [{ role: "user", content: "hello" }] },
      customFetch,
    });
    await expect(stream.next()).rejects.toThrow();
    expect(customFetch).toHaveBeenCalledOnce();
  });
});

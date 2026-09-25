import { describe, expect, it, vi } from "vitest";
import type { LlmChatInput, LlmStreamEvent } from "@maus-inc/types";
import type { CustomFetch } from "./types";
import { openaiStreamChat } from "./openai.utils";
import { groqStreamChat } from "./groq.utils";
import { deepseekStreamChat } from "./deepseek.utils";
import { openrouterStreamChat } from "./openrouter.utils";
import { cerebrasStreamChat } from "./cerebras.utils";
import { azureOpenaiStreamChat } from "./azure-openai.utils";
import { claudeStreamChat } from "./claude.utils";
import { geminiStreamChat } from "./gemini.utils";

type StreamArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch: CustomFetch;
};
type Adapter = (args: StreamArgs) => AsyncGenerator<LlmStreamEvent>;
const adapters: Array<[string, Adapter]> = [
  ["OpenAI", openaiStreamChat],
  ["Groq", groqStreamChat],
  ["DeepSeek", deepseekStreamChat],
  ["OpenRouter", openrouterStreamChat],
  ["Cerebras", cerebrasStreamChat],
  [
    "Azure OpenAI",
    (args) =>
      azureOpenaiStreamChat({
        ...args,
        endpoint: "https://example.test",
        deploymentName: "test-model",
      }),
  ],
  ["Claude", claudeStreamChat],
  ["Gemini", geminiStreamChat],
];

describe("streaming transport cancellation", () => {
  it.each(adapters)(
    "forwards caller cancellation through %s",
    async (_name, adapter) => {
      const controller = new AbortController();
      let transportSignal: AbortSignal | null | undefined;
      let release = () => {};
      const customFetch = vi.fn<CustomFetch>((_url, init) => {
        transportSignal = init?.signal;
        return new Promise<Response>((resolve, reject) => {
          release = () =>
            resolve(
              new Response("", {
                headers: { "content-type": "text/event-stream" },
              }),
            );
          transportSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        });
      });
      const stream = adapter({
        apiKey: "test-key",
        model: "test-model",
        input: {
          messages: [{ role: "user", content: "hello" }],
          signal: controller.signal,
        },
        customFetch,
      });
      const pending = stream.next();
      // SDKs can reject immediately on abort, before the assertions below await it.
      void pending.catch(() => {});
      try {
        await vi.waitFor(() => expect(customFetch).toHaveBeenCalledTimes(1));
        const body = customFetch.mock.calls[0][1]?.body;
        expect(typeof body).toBe("string");
        expect(JSON.parse(String(body))).not.toHaveProperty("signal");
        controller.abort();
        expect(transportSignal?.aborted).toBe(true);
        await expect(pending).rejects.toThrow();
        expect(customFetch).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await pending.catch(() => {});
        await stream.return(undefined);
      }
    },
  );
});

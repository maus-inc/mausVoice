import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmChatInput, LlmStreamEvent } from "@maus-inc/types";
import {
  azureOpenaiStreamChat,
  cerebrasStreamChat,
  claudeStreamChat,
  deepseekStreamChat,
  geminiStreamChat,
  groqStreamChat,
  openaiStreamChat,
  openrouterStreamChat,
} from "@maus-inc/voice-ai";
import {
  AzureOpenAIGenerateTextRepo,
  CerebrasGenerateTextRepo,
  ClaudeGenerateTextRepo,
  DeepseekGenerateTextRepo,
  GeminiGenerateTextRepo,
  GroqGenerateTextRepo,
  OllamaGenerateTextRepo,
  OpenAICompatibleGenerateTextRepo,
  OpenAICompatibleBaseGenerateTextRepo,
  OpenAIGenerateTextRepo,
  OpenRouterGenerateTextRepo,
} from "./generate-text.repo";

vi.mock("@maus-inc/voice-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@maus-inc/voice-ai")>();
  return {
    ...actual,
    azureOpenaiStreamChat: vi.fn(),
    cerebrasStreamChat: vi.fn(),
    claudeStreamChat: vi.fn(),
    deepseekStreamChat: vi.fn(),
    geminiStreamChat: vi.fn(),
    groqStreamChat: vi.fn(),
    openaiStreamChat: vi.fn(),
    openrouterStreamChat: vi.fn(),
  };
});

it("keeps the shared compatible-repo base for both supported endpoints", () => {
  expect(
    new OllamaGenerateTextRepo("http://localhost:11434/v1", "model"),
  ).toBeInstanceOf(OpenAICompatibleBaseGenerateTextRepo);
  expect(
    new OpenAICompatibleGenerateTextRepo("https://example.com/v1", "model"),
  ).toBeInstanceOf(OpenAICompatibleBaseGenerateTextRepo);
});

afterEach(() => vi.resetAllMocks());

const input: LlmChatInput = {
  messages: [{ role: "user", content: "test" }],
  tools: [{ name: "lookup", parameters: { type: "object" } }],
  signal: new AbortController().signal,
};
const events: LlmStreamEvent[] = [
  { type: "text-delta", text: "answer" },
  { type: "finish", finishReason: "stop" },
];
async function* providerStream() {
  yield* events;
}

const cases = [
  {
    name: "Groq",
    invoke: () =>
      new GroqGenerateTextRepo("key", "openai/gpt-oss-20b").streamChat(input),
    provider: groqStreamChat,
    expected: { apiKey: "key", model: "openai/gpt-oss-20b" },
  },
  {
    name: "OpenAI",
    invoke: () =>
      new OpenAIGenerateTextRepo("key", "gpt-4o-mini").streamChat(input),
    provider: openaiStreamChat,
    expected: { apiKey: "key", model: "gpt-4o-mini" },
  },
  {
    name: "OpenRouter",
    invoke: () =>
      new OpenRouterGenerateTextRepo("key", "model").streamChat(input),
    provider: openrouterStreamChat,
    expected: { apiKey: "key", model: "model" },
  },
  {
    name: "Azure",
    invoke: () =>
      new AzureOpenAIGenerateTextRepo(
        "key",
        "https://azure.test",
        "deployment",
      ).streamChat(input),
    provider: azureOpenaiStreamChat,
    expected: {
      apiKey: "key",
      endpoint: "https://azure.test",
      deploymentName: "deployment",
    },
  },
  {
    name: "DeepSeek",
    invoke: () =>
      new DeepseekGenerateTextRepo("key", "deepseek-chat").streamChat(input),
    provider: deepseekStreamChat,
    expected: { apiKey: "key", model: "deepseek-chat" },
  },
  {
    name: "Gemini",
    invoke: () => new GeminiGenerateTextRepo("key", "model").streamChat(input),
    provider: geminiStreamChat,
    expected: { apiKey: "key", model: "model" },
  },
  {
    name: "Claude",
    invoke: () => new ClaudeGenerateTextRepo("key", "model").streamChat(input),
    provider: claudeStreamChat,
    expected: { apiKey: "key", model: "model" },
  },
  {
    name: "Cerebras",
    invoke: () =>
      new CerebrasGenerateTextRepo("key", "model").streamChat(input),
    provider: cerebrasStreamChat,
    expected: { apiKey: "key", model: "model" },
  },
  {
    name: "Ollama",
    invoke: () =>
      new OllamaGenerateTextRepo(
        "http://127.0.0.1:11434/v1",
        "model",
      ).streamChat(input),
    provider: openaiStreamChat,
    expected: {
      apiKey: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "model",
    },
  },
  {
    name: "OpenAI-compatible",
    invoke: () =>
      new OpenAICompatibleGenerateTextRepo(
        "https://example.test/v1",
        "model",
        "key",
      ).streamChat(input),
    provider: openaiStreamChat,
    expected: {
      apiKey: "key",
      baseUrl: "https://example.test/v1",
      model: "model",
    },
  },
];

describe("provider streaming adapters", () => {
  it.each(cases)(
    "$name forwards inputs and relays every streamed event",
    async ({ invoke, provider, expected }) => {
      vi.mocked(provider).mockImplementation(providerStream);
      const received: LlmStreamEvent[] = [];
      for await (const event of invoke()) received.push(event);
      expect(received).toEqual(events);
      expect(provider).toHaveBeenCalledOnce();
      expect(provider).toHaveBeenCalledWith(
        expect.objectContaining({ ...expected, input }),
      );
    },
  );

  it.each(cases)(
    "$name propagates provider stream failures",
    async ({ invoke, provider }) => {
      const error = new Error("stream failed");
      vi.mocked(provider).mockImplementation(async function* () {
        yield events[0];
        throw error;
      });
      const stream = invoke();
      await expect(stream.next()).resolves.toEqual({
        done: false,
        value: events[0],
      });
      await expect(stream.next()).rejects.toBe(error);
    },
  );
});

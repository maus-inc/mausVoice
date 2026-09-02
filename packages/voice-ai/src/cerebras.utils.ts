import OpenAI from "openai";
import { retry } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";
import {
  buildJsonObjectPrompt,
  buildOpenAICompatibleMessages,
  parseOpenAICompatibleGenerateTextResponse,
} from "./openai-compatible-generate.utils";
import type { CustomFetch, DiscoveredModelId } from "./types";

export const CEREBRAS_MODELS = ["gpt-oss-120b", "gemma-4-31b"] as const;
export type CerebrasModel =
  (typeof CEREBRAS_MODELS)[number] | DiscoveredModelId;

const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: CEREBRAS_BASE_URL,
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
};

export type CerebrasGenerateTextArgs = {
  apiKey: string;
  model?: CerebrasModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  customFetch?: CustomFetch;
};

export type CerebrasGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const cerebrasGenerateTextResponse = async ({
  apiKey,
  model = CEREBRAS_MODELS[0],
  system,
  prompt,
  jsonResponse,
  maxTokens,
  customFetch,
}: CerebrasGenerateTextArgs): Promise<CerebrasGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const finalPrompt = buildJsonObjectPrompt({ prompt, jsonResponse });
      const messages = buildOpenAICompatibleMessages({
        system,
        prompt: finalPrompt,
      });

      const params: Record<string, unknown> = {
        messages,
        model,
        temperature: 1,
        max_tokens: maxTokens ?? 1024,
        top_p: 1,
        response_format: jsonResponse ? { type: "json_object" } : undefined,
      };
      const response = await client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      );

      console.log("cerebras llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "Cerebras",
      });
    },
  });
};

export type CerebrasTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const cerebrasTestIntegration = async ({
  apiKey,
  customFetch,
}: CerebrasTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type CerebrasStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* cerebrasStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: CerebrasStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, customFetch);
  yield* openaiCompatibleStreamChat(client, model, input);
}

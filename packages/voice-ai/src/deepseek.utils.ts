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

// Current hosted IDs from https://api-docs.deepseek.com/quick_start/pricing/.
// The legacy deepseek-chat/deepseek-reasoner aliases were retired in July 2026.
export const DEEPSEEK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;
export type DeepseekModel =
  (typeof DEEPSEEK_MODELS)[number] | DiscoveredModelId;

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: DEEPSEEK_BASE_URL,
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
};

export type DeepseekGenerateTextArgs = {
  apiKey: string;
  model?: DeepseekModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  customFetch?: CustomFetch;
};

export type DeepseekGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const deepseekGenerateTextResponse = async ({
  apiKey,
  model = DEEPSEEK_MODELS[0],
  system,
  prompt,
  jsonResponse,
  maxTokens,
  customFetch,
}: DeepseekGenerateTextArgs): Promise<DeepseekGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const finalPrompt = buildJsonObjectPrompt({ prompt, jsonResponse });
      const messages = buildOpenAICompatibleMessages({
        system,
        prompt: finalPrompt,
      });

      const response = await client.chat.completions.create({
        messages,
        model,
        temperature: 1,
        max_tokens: maxTokens ?? 1024,
        top_p: 1,
        response_format: jsonResponse ? { type: "json_object" } : undefined,
      });

      console.log("deepseek llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "DeepSeek",
      });
    },
  });
};

export type DeepseekTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const deepseekTestIntegration = async ({
  apiKey,
  customFetch,
}: DeepseekTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type DeepseekStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* deepseekStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: DeepseekStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, customFetch);
  yield* openaiCompatibleStreamChat(client, model, input);
}

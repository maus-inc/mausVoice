import OpenAI from "openai";
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { retry, countWords } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";
import { contentToString } from "./transcription.utils";
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
<<<<<<< HEAD
  maxTokens?: number;
=======
  customFetch?: CustomFetch;
>>>>>>> origin/fix/superfix-review-findings
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
<<<<<<< HEAD
  maxTokens,
=======
  customFetch,
>>>>>>> origin/fix/superfix-review-findings
}: DeepseekGenerateTextArgs): Promise<DeepseekGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }

      let finalPrompt = prompt;
      if (jsonResponse) {
        finalPrompt = `${prompt}\n\nRespond with valid JSON matching this schema: ${JSON.stringify(jsonResponse.schema)}`;
      }

      const userParts: ChatCompletionContentPart[] = [];
      userParts.push({ type: "text", text: finalPrompt });
      messages.push({ role: "user", content: userParts });

      const response = await client.chat.completions.create({
        messages,
        model,
        temperature: 1,
        max_tokens: maxTokens ?? 1024,
        top_p: 1,
        response_format: jsonResponse ? { type: "json_object" } : undefined,
      });

      console.log("deepseek llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from DeepSeek");
      }

      const result = response.choices[0].message.content;
      if (!result) {
        throw new Error("Content is empty");
      }

      const content = contentToString(result);
      return {
        text: content,
        tokensUsed: response.usage?.total_tokens ?? countWords(content),
      };
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

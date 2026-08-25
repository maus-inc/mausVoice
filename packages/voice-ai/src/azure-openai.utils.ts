import { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { retry, countWords } from "@maus-inc/utilities";
import { buildJsonSchemaResponseFormat } from "./response-format.utils";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";

export const AZURE_OPENAI_MODELS = [
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4",
  "gpt-35-turbo",
] as const;
export type AzureOpenAIModel = (typeof AZURE_OPENAI_MODELS)[number];

// Azure OpenAI deployments accept the same `json_schema` shape as the
// upstream OpenAI service. The set is keyed off the deployment name so
// user-deployed open-source models (Llama, Phi, etc.) fall back to
// `json_object` instead of being rejected.
const JSON_SCHEMA_SUPPORTED_MODELS = new Set<string>([
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4",
  "gpt-35-turbo",
]);

export type AzureOpenAIGenerateTextArgs = {
  apiKey: string;
  endpoint: string;
  deploymentName: string;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
};

const buildResponseFormat = (
  deploymentName: string,
  jsonResponse?: JsonResponse,
) => buildJsonSchemaResponseFormat(deploymentName, JSON_SCHEMA_SUPPORTED_MODELS, jsonResponse);

export type AzureOpenAIGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

const createClient = (apiKey: string, endpoint: string) => {
  return new AzureOpenAI({
    apiKey: apiKey.trim(),
    endpoint: endpoint.trim(),
    apiVersion: "2024-10-21",
    dangerouslyAllowBrowser: true,
  });
};

export const azureOpenAIGenerateText = async ({
  apiKey,
  endpoint,
  deploymentName,
  system,
  prompt,
  jsonResponse,
  maxTokens,
}: AzureOpenAIGenerateTextArgs): Promise<AzureOpenAIGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey, endpoint);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: prompt });

      const response_format = buildResponseFormat(deploymentName, jsonResponse);

      const response = await client.chat.completions.create({
        messages,
        model: deploymentName,
        temperature: 1,
        max_completion_tokens: maxTokens ?? 1024,
        response_format,
      });

      const content = response.choices?.[0]?.message?.content || "";
      return {
        text: content,
        tokensUsed: response.usage?.total_tokens ?? countWords(content),
      };
    },
  });
};

export type AzureOpenAITestIntegrationArgs = {
  apiKey: string;
  endpoint: string;
};

export const azureOpenAITestIntegration = async ({
  apiKey,
  endpoint,
}: AzureOpenAITestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, endpoint);
  await client.chat.completions.create({
    messages: [{ role: "user", content: "test" }],
    model: "gpt-4o-mini",
    max_completion_tokens: 5,
  });
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type AzureOpenAIStreamChatArgs = {
  apiKey: string;
  endpoint: string;
  deploymentName: string;
  input: LlmChatInput;
};

export async function* azureOpenaiStreamChat({
  apiKey,
  endpoint,
  deploymentName,
  input,
}: AzureOpenAIStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, endpoint);
  yield* openaiCompatibleStreamChat(client, deploymentName, input);
}

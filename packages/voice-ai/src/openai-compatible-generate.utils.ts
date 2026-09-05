import { countWords } from "@maus-inc/utilities";
import type { JsonResponse } from "@maus-inc/types";
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { contentToString } from "./transcription.utils";

export type OpenAICompatibleGenerateTextOptions = {
  messages?: ChatCompletionMessageParam[];
  userParts?: ChatCompletionContentPart[];
  system?: string;
  prompt: string;
  imageUrls?: string[];
};

export const buildOpenAICompatibleMessages = ({
  messages: providedMessages,
  userParts: providedUserParts,
  system,
  prompt,
  imageUrls = [],
}: OpenAICompatibleGenerateTextOptions): ChatCompletionMessageParam[] => {
  if (providedMessages) {
    return providedMessages;
  }
  const messages: ChatCompletionMessageParam[] = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }
  const userParts: ChatCompletionContentPart[] = providedUserParts ?? [];
  for (const url of imageUrls) {
    userParts.push({
      type: "image_url",
      image_url: { url },
    });
  }
  userParts.push({ type: "text", text: prompt });
  messages.push({ role: "user", content: userParts });
  return messages;
};

export type OpenAICompatibleChoiceLike = {
  choices?: Array<{
    message?: { content: string | null };
  }>;
  usage?: { total_tokens?: number | null } | null;
};

export type OpenAICompatibleGenerateTextResult = {
  text: string;
  tokensUsed: number;
};

export const parseOpenAICompatibleGenerateTextResponse = ({
  response,
  providerLabel,
}: {
  response: OpenAICompatibleChoiceLike;
  providerLabel: string;
}): OpenAICompatibleGenerateTextResult => {
  if (!response.choices || response.choices.length === 0) {
    throw new Error(`No response from ${providerLabel}`);
  }
  const result = response.choices[0].message?.content;
  if (!result) {
    throw new Error("Content is empty");
  }
  const content = contentToString(result);
  return {
    text: content,
    tokensUsed: response.usage?.total_tokens ?? countWords(content),
  };
};

export type BuildJsonObjectPromptInput = {
  prompt: string;
  jsonResponse?: JsonResponse;
};

export const buildJsonObjectPrompt = ({
  prompt,
  jsonResponse,
}: BuildJsonObjectPromptInput): string =>
  jsonResponse
    ? `${prompt}\n\nRespond with valid JSON matching this schema: ${JSON.stringify(jsonResponse.schema)}`
    : prompt;

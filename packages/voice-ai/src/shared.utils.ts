import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { JsonResponse } from "@maus-inc/types";

/**
 * Shared helpers used across the OpenAI-compatible provider adapters
 * (OpenAI, Groq, Cerebras, DeepSeek, xAI, ...) and the Anthropic/Gemini
 * streaming adapters. Keeping these in one place prevents each provider
 * file from re-implementing the same message/argument conversions.
 */

export const contentToString = (
  content: string | ChatCompletionContentPart[] | null | undefined,
): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text ?? "";
      }
      return "";
    })
    .join("")
    .trim();
};

export const buildChatMessages = ({
  system,
  prompt,
  imageUrls = [],
  jsonResponse,
}: {
  system?: string;
  prompt: string;
  imageUrls?: string[];
  jsonResponse?: JsonResponse | null;
}): ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }

  const finalPrompt = jsonResponse
    ? `${prompt}\n\nRespond with valid JSON matching this schema: ${JSON.stringify(jsonResponse.schema)}`
    : prompt;

  const userParts: ChatCompletionContentPart[] = [];
  for (const url of imageUrls) {
    userParts.push({
      type: "image_url",
      image_url: { url },
    });
  }

  userParts.push({ type: "text", text: finalPrompt });
  messages.push({ role: "user", content: userParts });
  return messages;
};

export const parseToolArguments = (args: string): Record<string, unknown> => {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const transcribeWithOpenAICompatClient = async <TClient extends { audio: { transcriptions: { create: (args: any) => Promise<{ text?: string | null }> } } }>(
  client: TClient,
  args: {
    blob: ArrayBuffer | Buffer;
    ext: string;
    model: string;
    prompt?: string;
    language?: string;
  },
): Promise<string> => {
  const { toFile } = await import("openai");
  const file = await toFile(args.blob, `audio.${args.ext}`);
  const response = await client.audio.transcriptions.create({
    file,
    model: args.model,
    prompt: args.prompt,
    language:
      args.language && args.language !== "auto" ? args.language : undefined,
  });

  if (!response.text) {
    throw new Error("Transcription failed");
  }
  return response.text;
};

export const createAudioFormData = (
  blob: ArrayBuffer | ArrayBufferView,
  ext: string,
): FormData => {
  const bodyData =
    blob instanceof ArrayBuffer
      ? blob
      : new Uint8Array(
          blob.buffer as ArrayBuffer,
          blob.byteOffset,
          blob.byteLength,
        ).buffer;
  const audioBlob = new Blob([bodyData], { type: `audio/${ext}` });
  const formData = new FormData();
  formData.append("file", audioBlob, `audio.${ext}`);
  return formData;
};

export type PostTranscriptionRequestArgs = {
  url: string;
  blob: ArrayBuffer | ArrayBufferView;
  ext: string;
  model: string;
  prompt?: string;
  language?: string;
  apiKey?: string;
  label: string;
  fetchImpl?: typeof fetch;
};

export const postTranscriptionRequest = async ({
  url,
  blob,
  ext,
  model,
  prompt,
  language,
  apiKey,
  label,
  fetchImpl = fetch,
}: PostTranscriptionRequestArgs): Promise<string> => {
  const formData = createAudioFormData(blob, ext);
  formData.append("model", model);
  if (prompt) {
    formData.append("prompt", prompt);
  }
  if (language && language !== "auto") {
    formData.append("language", language);
  }

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(url, {
    method: "POST",
    body: formData,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `${label} transcription failed: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as { text?: string };
  if (!data.text) {
    throw new Error("Transcription failed: no text in response");
  }
  return data.text;
};

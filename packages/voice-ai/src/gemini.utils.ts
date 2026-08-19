import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { retry, countWords } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
} from "@maus-inc/types";
import type { CustomFetch } from "./types";

export const GEMINI_GENERATE_TEXT_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-2.5-flash",
] as const;
export type GeminiGenerateTextModel = string;

export const GEMINI_TRANSCRIPTION_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
] as const;
export type GeminiTranscriptionModel = string;

const createClient = (apiKey: string) => {
  return new GoogleGenAI({ apiKey: apiKey.trim() });
};

const convertJsonSchemaToGeminiSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const converted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      const typeMap: Record<string, unknown> = {
        string: Type.STRING,
        number: Type.NUMBER,
        integer: Type.INTEGER,
        boolean: Type.BOOLEAN,
        array: Type.ARRAY,
        object: Type.OBJECT,
      };
      converted[key] = typeMap[value] ?? value;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      converted[key] = convertJsonSchemaToGeminiSchema(
        value as Record<string, unknown>,
      );
    } else if (Array.isArray(value)) {
      converted[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? convertJsonSchemaToGeminiSchema(item as Record<string, unknown>)
          : item,
      );
    } else {
      converted[key] = value;
    }
  }

  return converted;
};

export type GeminiTranscriptionArgs = {
  apiKey: string;
  model?: GeminiTranscriptionModel;
  blob: ArrayBuffer | Buffer;
  mimeType?: string;
  prompt?: string;
  language?: string;
};

export type GeminiTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const geminiTranscribeAudio = async ({
  apiKey,
  model = "gemini-3.7-flash",
  blob,
  mimeType = "audio/wav",
  prompt,
  language,
}: GeminiTranscriptionArgs): Promise<GeminiTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const bytes = new Uint8Array(blob);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const base64Audio = btoa(binary);

      let transcriptionPrompt = "Transcribe this audio accurately.";
      if (language && language !== "auto") {
        transcriptionPrompt += ` The audio is in ${language}.`;
      }
      if (prompt) {
        transcriptionPrompt += ` Context: ${prompt}`;
      }

      const response = await client.models.generateContent({
        model,
        contents: [
          {
            inlineData: {
              mimeType,
              data: base64Audio,
            },
          },
          { text: transcriptionPrompt },
        ],
      });

      const text = response.text ?? "";
      if (!text) {
        throw new Error("Transcription failed - empty response");
      }

      return { text, wordsUsed: countWords(text) };
    },
  });
};

export type GeminiGenerateTextArgs = {
  apiKey: string;
  model?: GeminiGenerateTextModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
};

export type GeminiGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const geminiGenerateTextResponse = async ({
  apiKey,
  model = "gemini-3.7-flash",
  system,
  prompt,
  jsonResponse,
}: GeminiGenerateTextArgs): Promise<GeminiGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      let fullPrompt = prompt;
      if (system) {
        fullPrompt = `${system}\n\n${prompt}`;
      }

      const config: Record<string, unknown> = {};
      if (jsonResponse) {
        config.responseMimeType = "application/json";
        if (jsonResponse.schema) {
          config.responseSchema = convertJsonSchemaToGeminiSchema(
            jsonResponse.schema as Record<string, unknown>,
          );
        }
      }

      const response = await client.models.generateContent({
        model,
        contents: fullPrompt,
        config: Object.keys(config).length > 0 ? config : undefined,
      });

      const text = response.text ?? "";
      if (!text) {
        throw new Error("No response from Gemini");
      }

      const usageMetadata = response.usageMetadata;
      const tokensUsed =
        (usageMetadata?.totalTokenCount as number) ?? countWords(text);

      console.log("gemini llm usage:", usageMetadata);

      return {
        text,
        tokensUsed,
      };
    },
  });
};

export type GeminiTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const geminiTestIntegration = async ({
  apiKey,
  customFetch = fetch,
}: GeminiTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}&pageSize=1`,
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `Gemini responded ${response.status}: ${detail}`
        : `Gemini responded with status ${response.status}`,
    );
  }
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

function llmMessagesToGemini(messages: LlmMessage[]): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = msg.content;
      continue;
    }

    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: Part[] = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      for (const tc of msg.toolCalls ?? []) {
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          parsedArgs = {};
        }
        parts.push({
          functionCall: { name: tc.name, args: parsedArgs },
        });
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.toolCallId,
              response: { result: msg.content },
            },
          },
        ],
      });
    }
  }

  return { systemInstruction, contents };
}

function geminiFinishReason(raw: string | undefined): LlmFinishReason {
  switch (raw) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
      return "content-filter";
    default:
      return "other";
  }
}

export type GeminiStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
};

type GeminiStreamState = {
  pendingToolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: LlmFinishReason;
  promptTokens?: number;
  completionTokens?: number;
  toolCallCounter: number;
};

const buildGeminiTools = (
  input: LlmChatInput,
): FunctionDeclaration[] | undefined => {
  if (!input.tools || input.tools.length === 0) {
    return undefined;
  }
  return input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
      ? convertJsonSchemaToGeminiSchema(t.parameters as Record<string, unknown>)
      : undefined,
  }));
};

const handleGeminiChunk = (
  chunk: GenerateContentResponse,
  state: GeminiStreamState,
): LlmStreamEvent[] => {
  const candidate = chunk.candidates?.[0];
  if (!candidate) {
    return [];
  }

  const events: LlmStreamEvent[] = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.text) {
      events.push({ type: "text-delta", text: part.text });
    }

    if (part.functionCall) {
      state.pendingToolCalls.push({
        id: `gemini-tc-${state.toolCallCounter++}`,
        name: part.functionCall.name ?? "",
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }

  if (candidate.finishReason) {
    state.finishReason = geminiFinishReason(candidate.finishReason as string);
  }

  if (chunk.usageMetadata) {
    state.promptTokens = chunk.usageMetadata.promptTokenCount ?? undefined;
    state.completionTokens =
      chunk.usageMetadata.candidatesTokenCount ?? undefined;
  }

  return events;
};

export async function* geminiStreamChat({
  apiKey,
  model,
  input,
}: GeminiStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey);
  const { systemInstruction, contents } = llmMessagesToGemini(input.messages);
  const tools = buildGeminiTools(input);

  const stream = await client.models.generateContentStream({
    model,
    contents,
    config: {
      systemInstruction: systemInstruction
        ? { parts: [{ text: systemInstruction }] }
        : undefined,
      maxOutputTokens: input.maxTokens,
      temperature: input.temperature,
      topP: input.topP,
      stopSequences: input.stopSequences,
      tools: tools ? [{ functionDeclarations: tools }] : undefined,
    },
  });

  const state: GeminiStreamState = {
    pendingToolCalls: [],
    finishReason: "other",
    toolCallCounter: 0,
  };

  for await (const chunk of stream) {
    yield* handleGeminiChunk(chunk, state);
  }

  for (const tc of state.pendingToolCalls) {
    yield {
      type: "tool-call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    };
  }

  yield {
    type: "finish",
    finishReason: state.finishReason,
    usage:
      state.promptTokens != null || state.completionTokens != null
        ? {
            promptTokens: state.promptTokens,
            completionTokens: state.completionTokens,
          }
        : undefined,
  };
}

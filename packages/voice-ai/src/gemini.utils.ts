import { retry, countWords } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
} from "@maus-inc/types";
import type { CustomFetch, DiscoveredModelId } from "./types";

export const GEMINI_GENERATE_TEXT_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-2.5-flash",
] as const;
export type GeminiGenerateTextModel =
  (typeof GEMINI_GENERATE_TEXT_MODELS)[number] | DiscoveredModelId;

export const GEMINI_TRANSCRIPTION_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
] as const;
export type GeminiTranscriptionModel =
  (typeof GEMINI_TRANSCRIPTION_MODELS)[number] | DiscoveredModelId;

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

type GeminiContent = {
  role?: "user" | "model";
  parts: GeminiPart[];
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

type GeminiGenerateContentRequest = {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: Record<string, unknown>;
};

const geminiModelPath = (model: string): string =>
  model
    .replace(/^models\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");

const requestGemini = async (
  apiKey: string,
  model: string,
  action: "generateContent" | "streamGenerateContent",
  body: GeminiGenerateContentRequest,
  customFetch: CustomFetch,
): Promise<Response> => {
  const suffix = action === "streamGenerateContent" ? "?alt=sse" : "";
  const response = await customFetch(
    `${GEMINI_API_URL}/models/${geminiModelPath(model)}:${action}${suffix}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey.trim(),
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `Gemini responded ${response.status}: ${detail}`
        : `Gemini responded with status ${response.status}`,
    );
  }

  return response;
};

const getGeminiResponseText = (
  response: GeminiGenerateContentResponse,
): string =>
  (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");

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
        string: "STRING",
        number: "NUMBER",
        integer: "INTEGER",
        boolean: "BOOLEAN",
        array: "ARRAY",
        object: "OBJECT",
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
  customFetch?: CustomFetch;
};

export type GeminiTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const geminiTranscribeAudio = async ({
  apiKey,
  model = GEMINI_TRANSCRIPTION_MODELS[0],
  blob,
  mimeType = "audio/wav",
  prompt,
  language,
  customFetch = fetch,
}: GeminiTranscriptionArgs): Promise<GeminiTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
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

      const httpResponse = await requestGemini(
        apiKey,
        model,
        "generateContent",
        {
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Audio,
                  },
                },
                { text: transcriptionPrompt },
              ],
            },
          ],
        },
        customFetch,
      );
      const response =
        (await httpResponse.json()) as GeminiGenerateContentResponse;
      const text = getGeminiResponseText(response);
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
  customFetch?: CustomFetch;
};

export type GeminiGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const geminiGenerateTextResponse = async ({
  apiKey,
  model = GEMINI_GENERATE_TEXT_MODELS[0],
  system,
  prompt,
  jsonResponse,
  customFetch = fetch,
}: GeminiGenerateTextArgs): Promise<GeminiGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      let fullPrompt = prompt;
      if (system) {
        fullPrompt = `${system}\n\n${prompt}`;
      }

      const generationConfig: Record<string, unknown> = {};
      if (jsonResponse) {
        generationConfig.responseMimeType = "application/json";
        if (jsonResponse.schema) {
          generationConfig.responseSchema = convertJsonSchemaToGeminiSchema(
            jsonResponse.schema as Record<string, unknown>,
          );
        }
      }

      const httpResponse = await requestGemini(
        apiKey,
        model,
        "generateContent",
        {
          contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
          generationConfig:
            Object.keys(generationConfig).length > 0
              ? generationConfig
              : undefined,
        },
        customFetch,
      );
      const response =
        (await httpResponse.json()) as GeminiGenerateContentResponse;
      const text = getGeminiResponseText(response);
      if (!text) {
        throw new Error("No response from Gemini");
      }

      const usageMetadata = response.usageMetadata;
      const tokensUsed = usageMetadata?.totalTokenCount ?? countWords(text);

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
  const response = await customFetch(`${GEMINI_API_URL}/models?pageSize=1`, {
    headers: { "x-goog-api-key": apiKey.trim() },
  });
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
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

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
      const parts: GeminiPart[] = [];
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
  customFetch?: CustomFetch;
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
): GeminiFunctionDeclaration[] | undefined => {
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
  chunk: GeminiGenerateContentResponse,
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

const parseGeminiSseEvent = (
  event: string,
): GeminiGenerateContentResponse | undefined => {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  return JSON.parse(data) as GeminiGenerateContentResponse;
};

async function* parseGeminiSse(
  response: Response,
): AsyncGenerator<GeminiGenerateContentResponse> {
  if (!response.body) {
    const event = parseGeminiSseEvent(await response.text());
    if (event) yield event;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : (events.pop() ?? "");
    for (const rawEvent of events) {
      const event = parseGeminiSseEvent(rawEvent);
      if (event) yield event;
    }

    if (done) {
      const event = parseGeminiSseEvent(buffer);
      if (event) yield event;
      return;
    }
  }
}

export async function* geminiStreamChat({
  apiKey,
  model,
  input,
  customFetch = fetch,
}: GeminiStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const { systemInstruction, contents } = llmMessagesToGemini(input.messages);
  const tools = buildGeminiTools(input);
  const response = await requestGemini(
    apiKey,
    model,
    "streamGenerateContent",
    {
      contents,
      systemInstruction: systemInstruction
        ? { parts: [{ text: systemInstruction }] }
        : undefined,
      tools: tools ? [{ functionDeclarations: tools }] : undefined,
      generationConfig: {
        maxOutputTokens: input.maxTokens,
        temperature: input.temperature,
        topP: input.topP,
        stopSequences: input.stopSequences,
      },
    },
    customFetch,
  );

  const state: GeminiStreamState = {
    pendingToolCalls: [],
    finishReason: "other",
    toolCallCounter: 0,
  };

  for await (const chunk of parseGeminiSse(response)) {
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

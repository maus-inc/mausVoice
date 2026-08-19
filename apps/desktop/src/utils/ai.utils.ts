import type { LlmMessage, UserPreferences } from "@maus-inc/types";
import { AppState } from "../state/app.state";
import { CPU_DEVICE_VALUE, DEFAULT_MODEL_SIZE } from "../types/ai.types";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeTranscriptionDevice,
  supportsGpuTranscriptionDevice,
} from "./local-transcription.utils";

export const unwrapNestedLlmResponse = <T extends Record<string, unknown>>(
  parsed: T,
  key: string & keyof T,
): T => {
  const value = parsed[key];
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === "string"
  ) {
    return { ...parsed, [key]: (value as Record<string, unknown>)[key] } as T;
  }
  return parsed;
};

export const extractJsonFromMarkdown = (text: string): string => {
  // Try to extract JSON from markdown code blocks
  const fenceStart = text.indexOf("```");
  if (fenceStart !== -1) {
    let bodyStart = fenceStart + 3;
    if (text.startsWith("json", bodyStart)) {
      bodyStart += 4;
    }
    while (bodyStart < text.length && /\s/.test(text[bodyStart]!)) {
      bodyStart += 1;
    }
    const fenceEnd = text.indexOf("```", bodyStart);
    if (fenceEnd !== -1) {
      return text.slice(bodyStart, fenceEnd).trim();
    }
  }

  // Try to extract JSON from inline code blocks (only if content looks like JSON)
  const inlineJsonMatch = text.match(/`([^`]+)`/g);
  if (inlineJsonMatch) {
    for (const match of inlineJsonMatch) {
      const content = match.slice(1, -1).trim();
      if (content.startsWith("{") || content.startsWith("[")) {
        return content;
      }
    }
  }

  // Return original text if no markdown formatting found
  return text.trim();
};

/**
 * Parses LLM JSON output, repairing truncation at the model's token limit
 * (the classic failure is `SyntaxError: Unterminated string in JSON at
 * position N`). Walks the tail of the extracted JSON backwards, dropping
 * partial tokens and re-closing the object until it parses, so a truncated
 * response degrades to whatever complete fields survived instead of
 * discarding the whole post-processing result.
 */
export const parsePostProcessingJson = (raw: string): unknown => {
  const extracted = extractJsonFromMarkdown(raw);

  // Fast path: complete JSON.
  try {
    return JSON.parse(extracted);
  } catch {
    // Fall through to truncation repair.
  }

  let cut = extracted.length;
  while (cut > 0) {
    const boundary = Math.max(
      extracted.lastIndexOf(",", cut - 1),
      extracted.lastIndexOf('"', cut - 1),
      extracted.lastIndexOf(" ", cut - 1),
      extracted.lastIndexOf("\n", cut - 1),
      extracted.lastIndexOf("\t", cut - 1),
    );
    if (boundary <= 0) {
      break;
    }
    cut = boundary;
    const repaired = `${extracted.slice(0, cut).replace(/,\s*$/, "")}"}`;
    try {
      return JSON.parse(repaired);
    } catch {
      // Keep cutting back towards the last complete boundary.
    }
  }

  throw new Error("Could not parse or repair LLM JSON output");
};

export const applyAiPreferences = (
  draft: AppState,
  preferences: UserPreferences,
): void => {
  draft.settings.aiTranscription.mode = preferences.transcriptionMode ?? null;
  draft.settings.aiTranscription.selectedApiKeyId =
    preferences.transcriptionApiKeyId ?? null;
  const normalizedDevice = normalizeTranscriptionDevice(
    preferences.transcriptionDevice ?? CPU_DEVICE_VALUE,
  );
  draft.settings.aiTranscription.device = normalizedDevice;
  draft.settings.aiTranscription.modelSize =
    preferences.transcriptionModelSize ?? DEFAULT_MODEL_SIZE;
  draft.settings.aiTranscription.gpuEnumerationEnabled =
    supportsGpuTranscriptionDevice() &&
    (preferences.gpuEnumerationEnabled ??
      isGpuPreferredTranscriptionDevice(normalizedDevice));

  draft.settings.aiPostProcessing.mode = preferences.postProcessingMode ?? null;
  draft.settings.aiPostProcessing.selectedApiKeyId =
    preferences.postProcessingApiKeyId ?? null;

  draft.settings.agentMode.mode = preferences.agentMode ?? null;
  draft.settings.agentMode.selectedApiKeyId =
    preferences.agentModeApiKeyId ?? null;
  draft.settings.agentMode.openclawGatewayUrl =
    preferences.openclawGatewayUrl ?? null;
  draft.settings.agentMode.openclawToken = preferences.openclawToken ?? null;
};

export function formatMessagesAsPrompt(messages: LlmMessage[]): {
  system: string | undefined;
  prompt: string;
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  if (nonSystemMessages.length <= 1) {
    const lastMsg = nonSystemMessages[0];
    let prompt: string;
    if (lastMsg?.role === "user") {
      prompt = lastMsg.content;
    } else if (lastMsg?.role === "assistant") {
      prompt = lastMsg.content ?? "";
    } else {
      prompt = "";
    }
    return {
      system: systemMsg?.content,
      prompt,
    };
  }

  const formatted = nonSystemMessages
    .map((m) => {
      if (m.role === "user") return `User: ${m.content}`;
      if (m.role === "assistant") return `Assistant: ${m.content ?? ""}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    system: systemMsg?.content,
    prompt: formatted,
  };
}

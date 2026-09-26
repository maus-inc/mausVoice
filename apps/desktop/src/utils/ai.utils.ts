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
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
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

export type ParsedPostProcessingJson = {
  value: unknown;
  /**
   * True only when the model never closed the object or string, which is what
   * a response cut at the token limit looks like. A finished document followed
   * by trailing prose, a stray comma, or a stray period parses on its own, so
   * it reports false: those are residue, not a lost tail.
   */
  repaired: boolean;
};

/** A comma that only survives because the model wrote `,}` or `,]`. */
const STRAY_TRAILING_COMMA_RE = /,\s*([}\]])/g;
/** A comma the truncation left hanging at the cut point. */
const DANGLING_TRAILING_COMMA_RE = /,\s*$/;

/**
 * Parses LLM JSON output, repairing truncation at the model's token limit
 * (the classic failure is `SyntaxError: Unterminated string in JSON at
 * position N`). Walks the tail of the extracted JSON backwards, dropping
 * partial tokens and re-closing the object until it parses, so a truncated
 * response still yields whatever complete fields survived instead of
 * discarding the whole post-processing result.
 *
 * The caller needs to know whether it got a whole answer or a salvaged
 * fragment, so each boundary is tried in order: parse the head exactly as the
 * model wrote it, and only re-close it when that fails. Re-closing is what
 * distinguishes a cut-off response, because only a truncated one has no
 * parseable prefix.
 */
export const parsePostProcessingJsonDetailed = (
  raw: string,
): ParsedPostProcessingJson => {
  const extracted = extractJsonFromMarkdown(raw);

  // Fast path: complete JSON.
  try {
    return { value: JSON.parse(extracted), repaired: false };
  } catch {
    // Fall through to truncation repair.
  }

  let cut = extracted.length;
  while (cut > 0) {
    const boundary = Math.max(
      extracted.lastIndexOf(",", cut - 1),
      extracted.lastIndexOf('"', cut - 1),
      // The closing brace is a boundary of its own: without it a response that
      // only carries a trailing period would be cut back to the closing quote
      // and re-closed, reporting a complete value as truncated.
      extracted.lastIndexOf("}", cut - 1),
      extracted.lastIndexOf(" ", cut - 1),
      extracted.lastIndexOf("\n", cut - 1),
      extracted.lastIndexOf("\t", cut - 1),
    );
    if (boundary <= 0) {
      break;
    }
    cut = boundary;
    for (const head of [extracted.slice(0, cut), extracted.slice(0, cut + 1)]) {
      // A head that already parses is a finished response whose tail is only
      // residue. Dropping a comma the model left before its own closing brace
      // removes that residue without inventing an end, so this is still a
      // complete answer. A genuinely truncated object has no parseable prefix
      // at any boundary, so this can never hide a lost tail.
      const withoutStrayComma = head.replace(STRAY_TRAILING_COMMA_RE, "$1");
      for (const candidate of new Set([head, withoutStrayComma])) {
        try {
          return { value: JSON.parse(candidate.trim()), repaired: false };
        } catch {
          // The outer object is still open, so this really was cut off.
        }
      }
    }
    const candidate = `${extracted.slice(0, cut).replace(DANGLING_TRAILING_COMMA_RE, "")}"}`;
    try {
      return { value: JSON.parse(candidate), repaired: true };
    } catch {
      // Keep cutting back towards the last complete boundary.
    }
  }

  throw new Error("Could not parse or repair LLM JSON output");
};

export const parsePostProcessingJson = (raw: string): unknown =>
  parsePostProcessingJsonDetailed(raw).value;

const preferenceOr = <T>(value: T | null | undefined, fallback: T): T =>
  value ?? fallback;

const applyTranscriptionPreferences = (
  draft: AppState,
  preferences: UserPreferences,
): void => {
  draft.settings.aiTranscription.mode = preferenceOr(
    preferences.transcriptionMode,
    null,
  );
  draft.settings.aiTranscription.selectedApiKeyId = preferenceOr(
    preferences.transcriptionApiKeyId,
    null,
  );
  const normalizedDevice = normalizeTranscriptionDevice(
    preferenceOr(preferences.transcriptionDevice, CPU_DEVICE_VALUE),
  );
  draft.settings.aiTranscription.device = normalizedDevice;
  draft.settings.aiTranscription.modelSize = preferenceOr(
    preferences.transcriptionModelSize,
    DEFAULT_MODEL_SIZE,
  );
  const gpuEnabled = preferenceOr(
    preferences.gpuEnumerationEnabled,
    isGpuPreferredTranscriptionDevice(normalizedDevice),
  );
  draft.settings.aiTranscription.gpuEnumerationEnabled =
    supportsGpuTranscriptionDevice() && gpuEnabled;
};

const applyGenerativePreferences = (
  draft: AppState,
  preferences: UserPreferences,
): void => {
  draft.settings.aiPostProcessing.mode = preferenceOr(
    preferences.postProcessingMode,
    null,
  );
  draft.settings.aiPostProcessing.selectedApiKeyId = preferenceOr(
    preferences.postProcessingApiKeyId,
    null,
  );
  draft.settings.agentMode.mode = preferenceOr(preferences.agentMode, null);
  draft.settings.agentMode.selectedApiKeyId = preferenceOr(
    preferences.agentModeApiKeyId,
    null,
  );
  draft.settings.agentMode.openclawGatewayUrl = preferenceOr(
    preferences.openclawGatewayUrl,
    null,
  );
  draft.settings.agentMode.openclawToken = preferenceOr(
    preferences.openclawToken,
    null,
  );
};

const applyFeaturePreferences = (
  draft: AppState,
  preferences: UserPreferences,
): void => {
  draft.settings.inDictationStyleSwitchingEnabled = preferenceOr(
    preferences.inDictationStyleSwitchingEnabled,
    false,
  );
  draft.settings.hallucinationFilterEnabled = preferenceOr(
    preferences.hallucinationFilterEnabled,
    true,
  );
  draft.settings.reviewBeforeInsert = preferences.reviewBeforeInsert === true;
  // `preferenceOr` preserves an explicit `[]` (deny-all) because `[] ?? null`
  // is `[]`, and defaults to `null` ("follow registry defaults") rather than
  // to an allow-list. Never migrate `null` into an all-tools list here.
  draft.settings.agentEnabledTools = preferenceOr(
    preferences.agentEnabledTools,
    null,
  );
  draft.settings.agentMaxIterations = preferenceOr(
    preferences.agentMaxIterations,
    20,
  );
  draft.settings.agentPermissionTimeoutMs = preferenceOr(
    preferences.agentPermissionTimeoutMs,
    60_000,
  );
};

export const applyAiPreferences = (
  draft: AppState,
  preferences: UserPreferences,
): void => {
  applyTranscriptionPreferences(draft, preferences);
  applyGenerativePreferences(draft, preferences);
  applyFeaturePreferences(draft, preferences);
};

export function formatMessagesAsPrompt(messages: LlmMessage[]): {
  system: string | undefined;
  prompt: string;
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  if (nonSystemMessages.length <= 1) {
    const lastMsg = nonSystemMessages[0];
    return {
      system: systemMsg?.content,
      prompt:
        lastMsg?.role === "user"
          ? lastMsg.content
          : lastMsg?.role === "assistant"
            ? (lastMsg.content ?? "")
            : "",
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

import type { LlmMessage, UserPreferences } from "@maus-inc/types";
import { unknownToMessage } from "@maus-inc/utilities";
import { AppState } from "../state/app.state";
import { CPU_DEVICE_VALUE, DEFAULT_MODEL_SIZE } from "../types/ai.types";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeTranscriptionDevice,
  supportsGpuTranscriptionDevice,
} from "./local-transcription.utils";

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

/**
 * Upper bound on the edits accepted from one cleanup reply. The prompt asks
 * for the smallest edit list that expresses the change, so a reply far past
 * this is either a rewritten transcript disguised as edits or a degenerate
 * loop; the surplus is dropped and reported instead of applied.
 */
export const MAX_TRANSCRIPTION_EDITS = 200;

export type TranscriptionEdit = {
  /** Text copied from the raw transcript. Must match exactly once. */
  find: string;
  /** Replacement text. An empty string deletes the match. */
  replace: string;
};

export type TranscriptionEditApplication = {
  text: string;
  applied: number;
  skipped: number;
};

/**
 * Applies cleanup edits to the raw transcript.
 *
 * Every edit must match the working text exactly once at the moment it is
 * applied. A missing or ambiguous match is skipped rather than guessed at,
 * because rewriting the wrong occurrence silently corrupts the dictation,
 * while leaving the model's edit unapplied only means that phrase stays as
 * dictated. Edits that do apply are kept, so a reply with one bad entry still
 * improves the rest of the text.
 */
export const applyTranscriptionEdits = (
  transcript: string,
  edits: TranscriptionEdit[],
): TranscriptionEditApplication => {
  let text = transcript;
  let applied = 0;
  const accepted = edits.slice(0, MAX_TRANSCRIPTION_EDITS);
  let skipped = edits.length - accepted.length;

  for (const edit of accepted) {
    const index = edit.find.length > 0 ? text.indexOf(edit.find) : -1;
    if (index === -1 || index !== text.lastIndexOf(edit.find)) {
      skipped += 1;
      continue;
    }
    text =
      text.slice(0, index) +
      edit.replace +
      text.slice(index + edit.find.length);
    applied += 1;
  }

  return { text, applied, skipped };
};

const hasResponseKeys = (record: Record<string, unknown>): boolean =>
  "edits" in record || "result" in record;

/**
 * Tolerates one level of key wrapping, which JSON object mode providers
 * produce when they echo the schema name instead of the schema shape
 * (`{ "transcription_cleaning": { "result": "..." } }`). Anything deeper, or
 * a wrapped value that is not an object, is left alone.
 */
const unwrapSingleObject = (
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const values = Object.values(record);
  const [value] = values;
  return values.length === 1 &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : record;
};

const readEdits = (value: unknown): TranscriptionEdit[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const edits: TranscriptionEdit[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { find, replace } = entry as { find?: unknown; replace?: unknown };
    if (typeof find !== "string") {
      continue;
    }
    edits.push({ find, replace: typeof replace === "string" ? replace : "" });
  }
  return edits;
};

/**
 * Reads the two reply shapes the cleanup contract allows, tolerating the
 * deviations that JSON object mode providers produce (a missing key, a
 * non-string `replace`, a rewrite sent in `result` when the schema asked for
 * edits). Reading is deliberately permissive and never throws: the fallback
 * decision belongs to `resolveProcessedTranscription`, which needs to tell
 * "the model sent nothing usable" apart from "the model violated the schema".
 */
const readProcessedTranscriptionResponse = (
  parsed: unknown,
): { edits: TranscriptionEdit[]; result: string } => {
  const record =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const source = hasResponseKeys(record) ? record : unwrapSingleObject(record);
  return {
    edits: readEdits(source.edits),
    result: typeof source.result === "string" ? source.result : "",
  };
};

export type ProcessedTranscriptionResolution =
  | { status: "cleaned"; transcript: string; warning: string | null }
  | {
      status: "unusable";
      /**
       * "unparseable" means the reply was not JSON at all; "empty" means the
       * reply parsed but carried no text. Production falls back to the raw
       * transcript either way, while the style preview shows the model's own
       * words for "unparseable" so a prose answer stays visible.
       */
      reason: "empty" | "unparseable";
      warning: string;
    };

/**
 * Resolves a cleanup reply into the text the pipeline should deliver.
 *
 * Order of preference: applied edits, then a full rewrite in `result`, then
 * the transcript unchanged. Edits win because they are the auditable shape:
 * each one either matched the transcript exactly once or was skipped.
 *
 * `transcript` is the text the edits were generated against, so the caller
 * can pass the raw transcript for production and a preview sample for the
 * style dialog. An empty transcript resolves to itself without a warning:
 * there is nothing to clean, and warning about an empty reply to empty input
 * would be noise.
 */
export const resolveProcessedTranscription = (
  reply: string,
  transcript: string,
): ProcessedTranscriptionResolution => {
  let parsed: unknown;
  try {
    parsed = parsePostProcessingJson(reply);
  } catch (error) {
    return {
      status: "unusable",
      reason: "unparseable",
      warning: `Failed to parse post-processing response: ${unknownToMessage(error)}`,
    };
  }

  const { edits, result } = readProcessedTranscriptionResponse(parsed);
  if (edits.length > 0) {
    const application = applyTranscriptionEdits(transcript, edits);
    if (application.applied > 0) {
      // The cap can drop edits before they are ever matched, so the warning
      // names the matching rule instead of claiming every skip was a miss.
      const capNote =
        edits.length > MAX_TRANSCRIPTION_EDITS
          ? ` Only the first ${MAX_TRANSCRIPTION_EDITS} edits were attempted.`
          : "";
      return {
        status: "cleaned",
        transcript: application.text,
        warning:
          application.skipped > 0
            ? `Applied ${application.applied} of ${edits.length} post-processing edits; ${application.skipped} could not be applied (an edit only applies when its text matches the transcript exactly once).${capNote}`
            : null,
      };
    }
  }

  const rewritten = result.trim();
  if (rewritten.length > 0) {
    return { status: "cleaned", transcript: rewritten, warning: null };
  }

  if (transcript.trim().length === 0) {
    return { status: "cleaned", transcript, warning: null };
  }

  return {
    status: "unusable",
    reason: "empty",
    warning:
      "Post-processing returned no usable text; kept the raw transcript. The reply may have been truncated at the model's token limit.",
  };
};

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

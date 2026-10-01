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
 * Parses LLM JSON output strictly. A response cut off at the model's token
 * limit is not valid JSON, so it throws and the caller keeps the full raw
 * transcript. Repairing it would silently drop the end of the dictation.
 */
export const parsePostProcessingJson = (raw: string): unknown =>
  JSON.parse(extractJsonFromMarkdown(raw));

/**
 * True when a reply that failed to parse opens a JSON object but ends inside
 * a string or with brackets still open, the shape of output cut off at the
 * model's token limit. Braces inside string values are ignored, and a code
 * fence cut off before it closed is tolerated.
 */
export const isLikelyTruncatedJson = (raw: string): boolean => {
  const body = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  if (!body.startsWith("{")) {
    return false;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of body) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return inString || depth > 0;
};

/**
 * Upper bound on the edits accepted from one cleanup reply. The prompt asks
 * for the smallest edit list that expresses the change, so a reply far past
 * this is either a rewritten transcript disguised as edits or a degenerate
 * loop; the surplus is dropped and reported instead of applied.
 */
export const MAX_TRANSCRIPTION_EDITS = 200;

export type TranscriptionEdit = {
  /** Text copied from the raw transcript. Must match exactly once, on word edges. */
  find: string;
  /**
   * Replacement text. An empty string deletes the match. `null` marks an edit
   * the model sent without usable replacement text, which is skipped and
   * counted rather than applied: the prompt reserves the empty string for a
   * deletion, so a missing key is not one the model asked for.
   */
  replace: string | null;
};

export type TranscriptionEditApplication = {
  text: string;
  applied: number;
  skipped: number;
};

/**
 * A letter or digit in any script, used to spot a `find` that matches a fragment
 * of a word.
 *
 * `\w` alone would be wrong here in both directions. It is ASCII, so an edit
 * replacing the start of `café` or `Grüße` passed the adjacency check and
 * spliced the word. Restricting the check to letters and digits rather than
 * treating every non-ASCII character as punctuation is what fixes that: the
 * rationale for ASCII-only was always about scripts written without spaces,
 * and those remain unaffected because their characters are letters, so two of
 * them adjacent is still inside one word.
 */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && WORD_CHARACTER.exec(character) !== null;

/** One code point of `value` at `index`, which may be a surrogate pair. */
const codePointAt = (value: string, index: number): string =>
  String.fromCodePoint(value.codePointAt(index) ?? 0);

/**
 * The UTF-16 length of the run of non-word characters at the start of `value`.
 *
 * `^[^\p{L}\p{N}]+/u` read this run and, unlike its trailing twin, stayed
 * linear because `^` fails every attempt but the first. It is a scan here so
 * that both ends of a `find` are read by one rule rather than two.
 *
 * Steps by code point but reports UTF-16 length, because the caller offsets
 * into the transcript by it and a character outside the basic plane counts as
 * two.
 */
const leadingNonWordLength = (value: string): number => {
  let index = 0;
  while (index < value.length) {
    const character = codePointAt(value, index);
    if (isWordCharacter(character)) return index;
    index += character.length;
  }
  return index;
};

/**
 * The UTF-16 length of the run of non-word characters at the end of `value`.
 *
 * `[^\p{L}\p{N}]+$/u` read this run and was quadratic, which is what Sonar
 * flagged: `$` only matches at the end of the string, so once the greedy run
 * falls short of it the engine gives the run back one character at a time, and
 * it starts the whole attempt over from the next position. A `find` of 32,000
 * punctuation characters followed by a letter took half a second to read and
 * takes nothing measurable to read now.
 *
 * One forward pass records where the last word character ended, which is where
 * the trailing run begins. Walking backwards instead would have to enter a
 * surrogate pair from its low surrogate, which is the mistake this avoids.
 */
const trailingNonWordLength = (value: string): number => {
  let index = 0;
  let wordEnd = 0;
  while (index < value.length) {
    const character = codePointAt(value, index);
    index += character.length;
    if (isWordCharacter(character)) wordEnd = index;
  }
  return value.length - wordEnd;
};

/**
 * True when the word characters inside `find` run against the middle of a word
 * in `text`, so applying the edit would splice a word in half. Punctuation and
 * spaces at either end of `find` are ignored because the prompt asks the model
 * to copy the surrounding space when deleting a word, which puts the match on
 * a boundary that is not one.
 */
const splitsWord = (text: string, find: string, index: number): boolean => {
  const start = index + leadingNonWordLength(find);
  const end = index + find.length - trailingNonWordLength(find);
  if (start >= end) {
    // Nothing but punctuation, so the match cannot land inside a word.
    return false;
  }
  return isWordCharacter(text[start - 1]) || isWordCharacter(text[end]);
};

/**
 * Applies cleanup edits to the raw transcript.
 *
 * Every edit must match the working text exactly once at the moment it is
 * applied, and on the edges of a word. A missing or ambiguous match, a match
 * inside a word, and a missing replacement are all skipped rather than guessed
 * at, because rewriting the wrong span silently corrupts the dictation, while
 * leaving the model's edit unapplied only means that phrase stays as dictated.
 * Edits that do apply are kept, so a reply with one bad entry still improves
 * the rest of the text.
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
    if (edit.replace === null) {
      skipped += 1;
      continue;
    }
    const index = edit.find.length > 0 ? text.indexOf(edit.find) : -1;
    if (
      index === -1 ||
      index !== text.lastIndexOf(edit.find) ||
      splitsWord(text, edit.find, index)
    ) {
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

/**
 * `dropped` counts the entries that named no usable `find` text, so no edit
 * could be read from them. They are counted rather than discarded because a
 * reply the provider mangled is a failure to report, and a count is the only
 * way the resolver can tell it apart from a model that chose to change nothing.
 */
type ReadEdits = {
  edits: TranscriptionEdit[];
  dropped: number;
};

const readEdits = (value: unknown): ReadEdits => {
  if (!Array.isArray(value)) {
    return { edits: [], dropped: 0 };
  }
  const edits: TranscriptionEdit[] = [];
  let dropped = 0;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      dropped += 1;
      continue;
    }
    const { find, replace } = entry as { find?: unknown; replace?: unknown };
    if (typeof find !== "string") {
      dropped += 1;
      continue;
    }
    edits.push({
      find,
      replace: typeof replace === "string" ? replace : null,
    });
  }
  return { edits, dropped };
};

/**
 * Reads the two reply shapes the cleanup contract allows, tolerating the
 * deviations that JSON object mode providers produce (a missing key, a
 * non-string `replace`, a rewrite sent in `result` when the schema asked for
 * edits). Reading is deliberately permissive and never throws: the fallback
 * decision belongs to `resolveProcessedTranscription`, which needs to tell
 * "the model sent nothing usable" apart from "the model violated the schema".
 *
 * `editsDeclared` separates a reply that carried an edit list, even an empty
 * one, from a reply with no list at all. Only the first means the model looked
 * at the transcript and chose to change nothing. `dropped` counts the entries
 * in that list that carried no usable `find` text, so a list the provider
 * mangled stays distinguishable from an empty one.
 */
const readProcessedTranscriptionResponse = (
  parsed: unknown,
): {
  edits: TranscriptionEdit[];
  editsDeclared: boolean;
  dropped: number;
  result: string;
} => {
  const record =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const source = hasResponseKeys(record) ? record : unwrapSingleObject(record);
  const { edits, dropped } = readEdits(source.edits);
  return {
    edits,
    editsDeclared: Array.isArray(source.edits),
    dropped,
    result: typeof source.result === "string" ? source.result : "",
  };
};

export type ProcessedTranscriptionResolution =
  | { status: "cleaned"; transcript: string; warning: string | null }
  | {
      status: "unusable";
      /**
       * "unparseable" means the reply was not JSON at all; "empty" means the
       * reply parsed but carried no text; "unreadable-edits" means it declared
       * an edit list the reply's shape did not let us read, so the model asked
       * for a change we could not act on. Production falls back to the raw
       * transcript either way, while the style preview shows the model's own
       * words for "unparseable" so a prose answer stays visible.
       */
      reason: "empty" | "unparseable" | "unreadable-edits";
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
 * would be noise. So does a reply carrying an empty edit list, which is how
 * the model answers when the tone already matches the speaker. A list we
 * could not read is neither of those: the model asked for a change that is
 * now lost, so it is reported as unusable rather than passed off as clean.
 */
/**
 * The edits branch of `resolveProcessedTranscription`, split out so the order of
 * preference reads as a list rather than as nesting. Returns null when the
 * edits do not decide the outcome, which is the one case where a rewrite the
 * model sent alongside them is the better text and the edits only need
 * reporting.
 */
const resolveAppliedEdits = (
  transcript: string,
  edits: TranscriptionEdit[],
  dropped: number,
  rewritten: string,
): ProcessedTranscriptionResolution | null => {
  const application = applyTranscriptionEdits(transcript, edits);
  const decides = application.applied > 0 || rewritten.length === 0;
  if (!decides) {
    return null;
  }
  // Entries the reply did not let us read are counted with the ones that did
  // not match, so the totals describe every entry the model sent and an unread
  // one cannot vanish from the report.
  const declared = edits.length + dropped;
  const skipped = application.skipped + dropped;
  // The cap can drop edits before they are ever matched, so the warning names
  // the matching rule instead of claiming every skip was a miss.
  const capNote =
    edits.length > MAX_TRANSCRIPTION_EDITS
      ? ` Only the first ${MAX_TRANSCRIPTION_EDITS} edits were attempted.`
      : "";
  return {
    status: "cleaned",
    transcript: application.text,
    warning:
      skipped > 0
        ? `Applied ${application.applied} of ${declared} post-processing edits; ${skipped} could not be applied (an edit only applies when it names find text as a string, its replacement is a string, and that find text matches the transcript exactly once, on the edges of a word).${capNote}`
        : null,
  };
};

/**
 * The reply declared an edit list. A list we could read is a model that asked
 * for a change we agreed with; a list we could not read is a change that is now
 * lost, which is reported rather than passed off as clean.
 */
const resolveDeclaredEdits = (
  transcript: string,
  dropped: number,
): ProcessedTranscriptionResolution => {
  if (dropped > 0) {
    return {
      status: "unusable",
      reason: "unreadable-edits",
      warning:
        "Post-processing returned edits that could not be read; kept the raw transcript. The reply may not match the shape the provider was asked for.",
    };
  }
  return { status: "cleaned", transcript, warning: null };
};

export const resolveProcessedTranscription = (
  reply: string,
  transcript: string,
): ProcessedTranscriptionResolution => {
  let parsed: unknown;
  try {
    parsed = parsePostProcessingJson(reply);
  } catch (error) {
    // A reply that opens an object and never closes it was cut off at the
    // model's token limit rather than malformed, and the two need different
    // remedies: a bigger output budget, not a retry. Saying so is the only
    // signal the user gets, because the parse error alone reads like noise.
    const truncated = isLikelyTruncatedJson(reply);
    const truncationHint = truncated
      ? " The model output may have been truncated at its token limit."
      : "";
    return {
      status: "unusable",
      reason: "unparseable",
      warning: `Failed to parse post-processing response: ${unknownToMessage(error)}.${truncationHint}`,
    };
  }

  const { edits, editsDeclared, dropped, result } =
    readProcessedTranscriptionResponse(parsed);
  const rewritten = result.trim();

  if (edits.length > 0) {
    const applied = resolveAppliedEdits(transcript, edits, dropped, rewritten);
    if (applied) {
      return applied;
    }
  }

  if (rewritten.length > 0) {
    return { status: "cleaned", transcript: rewritten, warning: null };
  }

  if (transcript.trim().length === 0) {
    return { status: "cleaned", transcript, warning: null };
  }

  if (editsDeclared) {
    return resolveDeclaredEdits(transcript, dropped);
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

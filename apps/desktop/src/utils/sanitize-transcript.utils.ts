import {
  applyHallucinationFiltering,
  type TranscriptionSegment,
} from "./hallucination.utils";
import { applySpokenCommands } from "./spoken-commands.utils";
import {
  applyReplacements,
  applySymbolConversions,
  type ReplacementRule,
} from "./string.utils";

export type SanitizeTranscriptOptions = {
  rawTranscript: string;
  replacementRules: ReplacementRule[];
  language?: string;
  spokenCommandsEnabled?: boolean;
  hallucinationFilterEnabled?: boolean;
  /** Skip scratch-that and newline/paragraph on realtime interim chunks. */
  skipStructuralCommands?: boolean;
  /** Provider verbose_json segments; enables the noSpeechProb gate when present. */
  segments?: TranscriptionSegment[] | null;
};

/**
 * Shared dictation sanitize pipeline.
 *
 * 1. Personal dictionary replacements (user wins over built-in commands)
 * 2. Deterministic silence-hallucination strip (PR #63 semantics).
 *    Runs before spoken commands so its sentence join cannot flatten
 *    inserted newlines.
 * 3. Spoken formatting / scratch-that (English, optional)
 * 4. Existing hashtag / pound-sign conversions
 */
export const sanitizeTranscriptText = ({
  rawTranscript,
  replacementRules,
  language,
  spokenCommandsEnabled = true,
  hallucinationFilterEnabled = true,
  skipStructuralCommands = false,
  segments = null,
}: SanitizeTranscriptOptions): string => {
  const replacedSegments = segments?.map((segment) => ({
    ...segment,
    text: applyReplacements(segment.text, replacementRules),
  }));
  const afterReplacements = applyReplacements(rawTranscript, replacementRules);
  const afterHallucination = applyHallucinationFiltering(
    afterReplacements,
    replacedSegments,
    language,
    hallucinationFilterEnabled,
  );
  const afterCommands = spokenCommandsEnabled
    ? applySpokenCommands(afterHallucination, language, {
        skipStructuralCommands,
      })
    : afterHallucination;
  return applySymbolConversions(afterCommands);
};

import { applyHallucinationFiltering } from "./hallucination.utils";
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
}: SanitizeTranscriptOptions): string => {
  const afterReplacements = applyReplacements(rawTranscript, replacementRules);
  const afterHallucination = applyHallucinationFiltering(
    afterReplacements,
    null,
    language,
    hallucinationFilterEnabled,
  );
  const afterCommands = spokenCommandsEnabled
    ? applySpokenCommands(afterHallucination, language)
    : afterHallucination;
  return applySymbolConversions(afterCommands);
};

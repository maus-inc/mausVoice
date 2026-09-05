import { getRec } from "@maus-inc/utilities";
import { getTranscriptionRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { extractAutoLearnTerms } from "../utils/auto-learn.utils";
import { getLogger } from "../utils/log.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import { createGlossaryTerms } from "./dictionary.actions";

export type SaveCorrectedTranscriptResult = {
  /** Glossary terms that were auto-learned from the correction. */
  learnedTerms: string[];
  /** Glossary-term inserts that failed, so callers can report partial success. */
  failedTerms: number;
};

const learnTermsFromCorrection = async (
  original: string,
  corrected: string,
): Promise<{ learnedTerms: string[]; failedTerms: number }> => {
  const state = getAppState();
  // Only non-empty values are candidates for the existing-terms set; a
  // glossary term always carries an empty destinationValue.
  const existingTerms = Object.values(state.termById).flatMap((term) =>
    term.destinationValue
      ? [term.sourceValue, term.destinationValue]
      : [term.sourceValue],
  );

  const { learnedTerms } = extractAutoLearnTerms({
    original,
    corrected,
    existingTerms,
  });

  if (learnedTerms.length === 0) {
    return { learnedTerms: [], failedTerms: 0 };
  }

  // createGlossaryTerms absorbs per-term persistence errors (it logs and
  // continues) and reports them through `failed`, so a glossary failure is
  // surfaced as partial success rather than thrown here.
  const { created, failed } = await createGlossaryTerms(learnedTerms);
  return {
    learnedTerms: created.map((term) => term.sourceValue),
    failedTerms: failed,
  };
};

/**
 * Persists a user's manual correction to a transcription's final text and,
 * when auto-learn is enabled, adds only corrected tokens beginning with an
 * uppercase letter as proper-noun-like glossary terms.
 */
export const saveCorrectedTranscript = async ({
  transcriptionId,
  correctedText,
}: {
  transcriptionId: string;
  correctedText: string;
}): Promise<SaveCorrectedTranscriptResult> => {
  const state = getAppState();
  const transcription = getRec(state.transcriptionById, transcriptionId);
  if (!transcription) {
    throw new Error("Transcription not found.");
  }

  const normalized = correctedText.trim();
  if (!normalized) {
    throw new Error("Transcript cannot be empty.");
  }

  const previous = transcription;
  const updated = { ...transcription, transcript: normalized };

  produceAppState((draft) => {
    draft.transcriptionById[transcriptionId] = updated;
  });

  let learnedTerms: string[] = [];
  let failedTerms = 0;
  try {
    const persisted = await getTranscriptionRepo().updateTranscription(updated);
    produceAppState((draft) => {
      draft.transcriptionById[transcriptionId] = persisted;
    });

    const autoLearnEnabled =
      getMyUserPreferences(getAppState())?.autoLearnDictionaryEnabled ?? true;
    if (autoLearnEnabled) {
      const result = await learnTermsFromCorrection(
        previous.transcript,
        normalized,
      );
      learnedTerms = result.learnedTerms;
      failedTerms = result.failedTerms;
    }
  } catch (error) {
    produceAppState((draft) => {
      draft.transcriptionById[transcriptionId] = previous;
    });
    getLogger().error(`Failed to save corrected transcript: ${error}`);
    throw error;
  }

  return { learnedTerms, failedTerms };
};

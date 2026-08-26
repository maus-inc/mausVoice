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
};

const learnTermsFromCorrection = async (
  original: string,
  corrected: string,
): Promise<string[]> => {
  const state = getAppState();
  const existingTerms = Object.values(state.termById).flatMap((term) => [
    term.sourceValue,
    term.destinationValue,
  ]);

  const { learnedTerms } = extractAutoLearnTerms({
    original,
    corrected,
    existingTerms,
  });

  if (learnedTerms.length === 0) {
    return [];
  }

  const created = await createGlossaryTerms(learnedTerms);
  return created.map((term) => term.sourceValue);
};

/**
 * Persists a user's manual correction to a transcription's final text and,
 * when auto-learn is enabled, adds the corrected words to the dictionary as
 * glossary terms.
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
  try {
    const persisted = await getTranscriptionRepo().updateTranscription(updated);
    produceAppState((draft) => {
      draft.transcriptionById[transcriptionId] = persisted;
    });

    const autoLearnEnabled =
      getMyUserPreferences(getAppState())?.autoLearnDictionaryEnabled ?? true;
    if (autoLearnEnabled) {
      learnedTerms = await learnTermsFromCorrection(
        previous.transcript,
        normalized,
      );
    }
  } catch (error) {
    produceAppState((draft) => {
      draft.transcriptionById[transcriptionId] = previous;
    });
    getLogger().error(`Failed to save corrected transcript: ${error}`);
    throw error;
  }

  return { learnedTerms };
};

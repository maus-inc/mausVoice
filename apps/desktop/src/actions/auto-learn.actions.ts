import { getRec } from "@maus-inc/utilities";
import { getIntl } from "../i18n/intl";
import { getTranscriptionRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { extractAutoLearnTerms } from "../utils/auto-learn.utils";
import { collectTermValues } from "../utils/app.utils";
import { isPersistenceAllowed } from "../utils/incognito.utils";
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
  const existingTerms = collectTermValues(state);

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
    // The details dialog hands a thrown `Error` straight to the error snackbar,
    // so the sentence has to come from the intl layer rather than being written
    // out here.
    throw new Error(
      getIntl().formatMessage({ defaultMessage: "Transcription not found." }),
    );
  }

  const normalized = correctedText.trim();
  if (!normalized) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "Transcript cannot be empty.",
      }),
    );
  }

  const previous = transcription;
  const updated = { ...transcription, transcript: normalized };

  produceAppState((draft) => {
    draft.transcriptionById[transcriptionId] = updated;
  });

  // One decision, read once, for both writes this function performs: the history
  // row and the glossary. Reading it separately per write would let the two
  // disagree if the mode changed while an await was in flight.
  const persistenceAllowed = isPersistenceAllowed();

  let learnedTerms: string[] = [];
  let failedTerms = 0;
  try {
    // Editing a transcript is a write to the history row like any other, so it
    // answers the same privacy gate. Under incognito mode or an ephemeral
    // session the correction stays in memory only: writing it out would put
    // back exactly the transcript the mode promised to leave unsaved.
    const persisted = persistenceAllowed
      ? await getTranscriptionRepo().updateTranscription(updated)
      : updated;
    produceAppState((draft) => {
      draft.transcriptionById[transcriptionId] = persisted;
    });

    const autoLearnEnabled =
      getMyUserPreferences(getAppState())?.autoLearnDictionaryEnabled ?? true;
    // The glossary answers the same gate as the transcript write, and for a
    // sharper reason: the learned terms are proper nouns lifted verbatim out of
    // the corrected text, so persisting them would leave the sensitive content
    // behind in a table the mode never promised to touch. Gating only the
    // transcript write left the dictionary as the surviving copy.
    if (autoLearnEnabled && persistenceAllowed) {
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

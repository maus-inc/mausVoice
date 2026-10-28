import { getRec } from "@maus-inc/utilities";
import { getIntl } from "../i18n/intl";
import { getTranscriptionRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { extractAutoLearnTerms } from "../utils/auto-learn.utils";
import { collectTermValues } from "../utils/app.utils";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { createGlossaryTerms } from "./dictionary.actions";

export type SaveCorrectedTranscriptResult = {
  /** Glossary terms that were auto-learned from the correction. */
  learnedTerms: string[];
  /** Glossary-term inserts that failed, so callers can report partial success. */
  failedTerms: number;
  /**
   * Auto-learn was wanted but the glossary write was refused, so the caller can
   * say why the dictionary stayed empty. Without this the caller can only see an
   * empty list, which is indistinguishable from a correction that taught it
   * nothing -- and "Incognito is on" is the whole explanation.
   */
  dictionarySuppressed: boolean;
};

const learnTermsFromCorrection = async (
  original: string,
  corrected: string,
  lease: LocalDataWriteLease,
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
  const { created, failed } = await createGlossaryTerms(learnedTerms, lease);
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
  const normalized = correctedText.trim();
  if (!normalized) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "Transcript cannot be empty.",
      }),
    );
  }

  return withLocalDataWrite(async (lease) => {
    const transcription = getRec(
      getAppState().transcriptionById,
      transcriptionId,
    );
    if (!transcription) {
      // The details dialog hands a thrown `Error` straight to the error snackbar,
      // so the sentence has to come from the intl layer rather than being written
      // out here.
      throw new Error(
        getIntl().formatMessage({ defaultMessage: "Transcription not found." }),
      );
    }

    const previous = transcription;
    const updated = { ...transcription, transcript: normalized };

    produceAppState((draft) => {
      draft.transcriptionById[transcriptionId] = updated;
    }, lease);

    let learnedTerms: string[] = [];
    let failedTerms = 0;
    let dictionarySuppressed = false;
    try {
      // Use one privacy decision for both writes. Reading it after an await could
      // let the transcript and glossary disagree if the mode changed in between.
      const persistenceAllowed = isPersistenceAllowed();

      // Under incognito mode or an ephemeral session the correction stays in
      // memory only, so the history row is not written back to disk.
      const persisted = persistenceAllowed
        ? await getTranscriptionRepo().updateTranscription(updated, lease)
        : updated;
      produceAppState((draft) => {
        draft.transcriptionById[transcriptionId] = persisted;
      }, lease);

      const autoLearnEnabled =
        getMyUserPreferences(getAppState())?.autoLearnDictionaryEnabled ?? true;
      // Learned proper nouns contain text from the correction itself, so the
      // glossary follows the same persistence decision as the history row.
      if (autoLearnEnabled && persistenceAllowed) {
        const result = await learnTermsFromCorrection(
          previous.transcript,
          normalized,
          lease,
        );
        learnedTerms = result.learnedTerms;
        failedTerms = result.failedTerms;
      } else if (autoLearnEnabled) {
        dictionarySuppressed = true;
      }
    } catch (error) {
      produceAppState((draft) => {
        draft.transcriptionById[transcriptionId] = previous;
      }, lease);
      getLogger().error(`Failed to save corrected transcript: ${error}`);
      throw error;
    }

    return { learnedTerms, failedTerms, dictionarySuppressed };
  });
};

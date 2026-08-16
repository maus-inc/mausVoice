import { Transcription } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getTranscriptionRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import type { AppState } from "../state/app.state";
import { orNull } from "../utils/nullable.utils";
import {
  applyReplacements,
  applySymbolConversions,
  type ReplacementRule,
} from "../utils/string.utils";
import {
  postProcessTranscript,
  storeTranscription,
  transcribeAudio,
} from "./transcribe.actions";

const getReplacementRules = (state: AppState): ReplacementRule[] =>
  Object.values(state.termById)
    .filter((term) => term.isReplacement)
    .map((term) => ({
      sourceValue: term.sourceValue,
      destinationValue: term.destinationValue,
    }));

const buildRetranscriptionPayload = ({
  transcription,
  rawTranscript,
  sanitizedTranscript,
  finalTranscript,
  metadata,
  warnings,
}: {
  transcription: Transcription;
  rawTranscript: string;
  sanitizedTranscript: string;
  finalTranscript: string;
  metadata: Record<string, unknown>;
  warnings: string[];
}): Transcription => ({
  ...transcription,
  transcript: finalTranscript,
  sanitizedTranscript,
  modelSize: orNull(metadata?.modelSize as string | null | undefined),
  inferenceDevice: orNull(
    metadata?.inferenceDevice as string | null | undefined,
  ),
  rawTranscript: rawTranscript ?? finalTranscript,
  transcriptionPrompt: orNull(
    metadata?.transcriptionPrompt as string | null | undefined,
  ),
  postProcessPrompt: orNull(
    metadata?.postProcessPrompt as string | null | undefined,
  ),
  transcriptionApiKeyId: orNull(
    metadata?.transcriptionApiKeyId as string | null | undefined,
  ),
  postProcessApiKeyId: orNull(
    metadata?.postProcessApiKeyId as string | null | undefined,
  ),
  transcriptionMode: orNull(
    metadata?.transcriptionMode as Transcription["transcriptionMode"],
  ),
  postProcessMode: orNull(
    metadata?.postProcessMode as Transcription["postProcessMode"],
  ),
  postProcessDevice: orNull(
    metadata?.postProcessDevice as string | null | undefined,
  ),
  warnings: warnings.length > 0 ? warnings : null,
});

export const openTranscriptionDetailsDialog = (transcriptionId: string) => {
  produceAppState((draft) => {
    draft.transcriptions.detailsDialogTranscriptionId = transcriptionId;
    draft.transcriptions.detailsDialogOpen = true;
  });
};

export const closeTranscriptionDetailsDialog = () => {
  produceAppState((draft) => {
    draft.transcriptions.detailsDialogOpen = false;
  });
};

export const openRetranscribeDialog = (transcriptionId: string) => {
  produceAppState((draft) => {
    draft.transcriptions.retranscribeDialogTranscriptionId = transcriptionId;
    draft.transcriptions.retranscribeDialogOpen = true;
  });
};

export const closeRetranscribeDialog = () => {
  produceAppState((draft) => {
    draft.transcriptions.retranscribeDialogOpen = false;
  });
};

type ProcessAudioParams = {
  samples: number[] | Float32Array;
  sampleRate: number;
  toneId?: string | null;
  languageCode?: string | null;
};

type ProcessedAudio = Awaited<ReturnType<typeof processAudio>>;

const getReplacementRules = () =>
  Object.values(getAppState().termById)
    .filter((term) => term.isReplacement)
    .map((term) => ({
      sourceValue: term.sourceValue,
      destinationValue: term.destinationValue,
    }));

const sanitizeImportedTranscript = (rawTranscript: string): string => {
  const replaced = applyReplacements(rawTranscript, getReplacementRules());
  return applySymbolConversions(replaced);
};

const processAudio = async ({
  samples,
  sampleRate,
  toneId,
  languageCode,
}: ProcessAudioParams) => {
  const transcribeResult = await transcribeAudio({
    samples,
    sampleRate,
    dictationLanguage: languageCode ?? undefined,
  });
  const sanitizedTranscript = sanitizeImportedTranscript(
    transcribeResult.sanitizedTranscript,
  );
  const postProcessResult = await postProcessTranscript({
    rawTranscript: sanitizedTranscript,
    toneId: toneId ?? null,
    dictationLanguage: languageCode ?? undefined,
  });

  return { transcribeResult, sanitizedTranscript, postProcessResult };
};

const updateStoredTranscription = async (
  transcription: Transcription,
  processed: ProcessedAudio,
): Promise<Transcription> => {
  const { transcribeResult, sanitizedTranscript, postProcessResult } =
    processed;
  const warnings = [
    ...transcribeResult.warnings,
    ...postProcessResult.warnings,
  ];
  const metadata = {
    ...transcribeResult.metadata,
    ...postProcessResult.metadata,
  };
  const finalTranscript = postProcessResult.transcript;
  if (!finalTranscript) throw new Error("Retranscription produced no text.");

  return getTranscriptionRepo().updateTranscription({
    ...transcription,
    transcript: finalTranscript,
    sanitizedTranscript,
    modelSize: metadata.modelSize ?? null,
    inferenceDevice: metadata.inferenceDevice ?? null,
    rawTranscript: transcribeResult.rawTranscript || finalTranscript,
    transcriptionPrompt: metadata.transcriptionPrompt ?? null,
    postProcessPrompt: metadata.postProcessPrompt ?? null,
    transcriptionApiKeyId: metadata.transcriptionApiKeyId ?? null,
    postProcessApiKeyId: metadata.postProcessApiKeyId ?? null,
    transcriptionMode: metadata.transcriptionMode ?? null,
    postProcessMode: metadata.postProcessMode ?? null,
    postProcessDevice: metadata.postProcessDevice ?? null,
    warnings: warnings.length > 0 ? warnings : null,
  });
};

type RetranscribeTranscriptionParams = {
  transcriptionId: string;
  toneId?: string | null;
  languageCode?: string | null;
};

export const retranscribeTranscription = async ({
  transcriptionId,
  toneId,
  languageCode,
}: RetranscribeTranscriptionParams): Promise<void> => {
  const transcription = getRec(
    getAppState().transcriptionById,
    transcriptionId,
  );
  if (!transcription) throw new Error("Transcription not found.");

  const audioData =
    await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);
  const processed = await processAudio({
    samples: audioData.samples,
    sampleRate: audioData.sampleRate,
    toneId,
    languageCode,
  });

  const rawTranscript = transcribeResult.rawTranscript;

  const afterReplacements = applyReplacements(
    rawTranscript,
    getReplacementRules(state),
  );
  const sanitizedTranscript = applySymbolConversions(afterReplacements);

  const postProcessResult = await postProcessTranscript({
    rawTranscript: sanitizedTranscript,
    toneId: toneId ?? null,
    dictationLanguage: languageCode ?? undefined,
  });

  const finalTranscript = postProcessResult.transcript;

  if (!finalTranscript) {
    throw new Error("Retranscription produced no text.");
  }

  const updatedPayload = buildRetranscriptionPayload({
    transcription,
    rawTranscript,
    sanitizedTranscript,
    finalTranscript,
    metadata: {
      ...transcribeResult.metadata,
      ...postProcessResult.metadata,
    },
    warnings: [...transcribeResult.warnings, ...postProcessResult.warnings],
  });

  const updated = await repo.updateTranscription(updatedPayload);

  produceAppState((draft) => {
    draft.transcriptionById[transcriptionId] = updated;
  });
};

export type ImportAudioParams = {
  path: string;
  toneId?: string | null;
  languageCode?: string | null;
};

/** Import a file, decode it in Rust, then use the exact live dictation pipeline. */
export const importAudioFile = async ({
  path,
  toneId,
  languageCode,
}: ImportAudioParams): Promise<void> => {
  const audio = await getTranscriptionRepo().importAudioFile(path);
  const processed = await processAudio({
    samples: audio.samples,
    sampleRate: audio.sampleRate,
    toneId,
    languageCode,
  });
  const { transcribeResult, sanitizedTranscript, postProcessResult } =
    processed;

  await storeTranscription({
    audio: { samples: audio.samples, sampleRate: audio.sampleRate },
    rawTranscript: transcribeResult.rawTranscript || null,
    sanitizedTranscript,
    transcript: postProcessResult.transcript || null,
    transcriptionMetadata: transcribeResult.metadata,
    postProcessMetadata: postProcessResult.metadata,
    warnings: [...transcribeResult.warnings, ...postProcessResult.warnings],
  });
};

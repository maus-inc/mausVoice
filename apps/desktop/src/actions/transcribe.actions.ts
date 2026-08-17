import { invoke } from "@tauri-apps/api/core";
import {
  Nullable,
  Transcription,
  TranscriptionAudioSnapshot,
} from "@maus-inc/types";
import { countWords, dedup } from "@maus-inc/utilities";
import dayjs from "dayjs";
import {
  getGenerateTextRepo,
  getTranscribeAudioRepo,
  getTranscriptionRepo,
} from "../repos";
import { TranscribeAudioOutput } from "../repos/transcribe-audio.repo";
import { getAppState, produceAppState } from "../store";
import { PostProcessingMode, TranscriptionMode } from "../types/ai.types";
import { AudioSamples } from "../types/audio.types";
import { StopRecordingResponse } from "../types/transcription-session.types";
import {
  parsePostProcessingJson,
  unwrapNestedLlmResponse,
} from "../utils/ai.utils";
import { createId } from "../utils/id.utils";
import {
  coerceToDictationLanguage,
  mapDictationLanguageToWhisperLanguage,
} from "../utils/language.utils";
import { orFalse, orNull } from "../utils/nullable.utils";
import { getLogger } from "../utils/log.utils";
import {
  buildLocalizedTranscriptionPrompt,
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  collectDictionaryEntries,
  PostProcessingPromptInput,
  PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
  PROCESSED_TRANSCRIPTION_SCHEMA,
} from "../utils/prompt.utils";
import { applyHallucinationFiltering } from "../utils/hallucination.utils";
import { getToneById, getToneConfig } from "../utils/tone.utils";
import {
  getMyEffectiveUserId,
  getMyUserName,
  loadMyEffectiveDictationLanguage,
} from "../utils/user.utils";
import { showErrorSnackbar } from "./app.actions";
import { addWordsToCurrentUser } from "./user.actions";

export type TranscribeAudioInput = {
  samples: AudioSamples;
  sampleRate: number;
  dictationLanguage?: string;
};

export type TranscribeAudioMetadata = {
  modelSize?: string | null;
  inferenceDevice?: string | null;
  transcriptionPrompt?: string | null;
  transcriptionApiKeyId?: string | null;
  transcriptionMode?: TranscriptionMode | null;
  transcriptionDurationMs?: number | null;
};

export type TranscribeAudioResult = {
  /** Exact provider output before replacements or hallucination filtering. */
  rawTranscript: string;
  /** Text used by post-processing and output routing. */
  sanitizedTranscript: string;
  warnings: string[];
  metadata: TranscribeAudioMetadata;
};

export type PostProcessInput = {
  rawTranscript: string;
  toneId: Nullable<string>;
  dictationLanguage?: string;
};

export type PostProcessMetadata = {
  postProcessPrompt?: string | null;
  postProcessApiKeyId?: string | null;
  postProcessMode?: PostProcessingMode | null;
  postProcessDevice?: string | null;
  postprocessDurationMs?: number | null;
};

export type PostProcessResult = {
  transcript: string;
  warnings: string[];
  metadata: PostProcessMetadata;
};

// Combined metadata type for storage compatibility
export type TranscriptionMetadata = TranscribeAudioMetadata &
  PostProcessMetadata & {
    rawTranscript?: string | null;
  };

/**
 * Transcribe audio samples to text.
 * This is the first step - just converts audio to raw transcript.
 */
export const transcribeAudio = async ({
  samples,
  sampleRate,
  dictationLanguage: dictationLanguageOverride,
}: TranscribeAudioInput): Promise<TranscribeAudioResult> => {
  const state = getAppState();

  const metadata: TranscribeAudioMetadata = {};
  const warnings: string[] = [];

  const {
    repo: transcribeRepo,
    apiKeyId: transcriptionApiKeyId,
    warnings: transcribeWarnings,
  } = getTranscribeAudioRepo();
  warnings.push(...transcribeWarnings);

  // Dispatch warnings (e.g. a stale provider selection) must not be lost when
  // the transcription call itself throws: log them before the network call so
  // they always reach the log, and attach them to the thrown error below.
  if (warnings.length > 0) {
    getLogger().warning(`Transcription warnings: ${warnings.join("; ")}`);
  }

  const dictationLanguage = dictationLanguageOverride
    ? coerceToDictationLanguage(dictationLanguageOverride)
    : await loadMyEffectiveDictationLanguage(state);
  const whisperLanguage =
    mapDictationLanguageToWhisperLanguage(dictationLanguage);

  getLogger().verbose(
    `Transcribing audio: language=${dictationLanguage}, whisper=${whisperLanguage}, sampleRate=${sampleRate}`,
  );

  const dictionaryEntries = collectDictionaryEntries(state);
  const transcriptionPrompt = buildLocalizedTranscriptionPrompt({
    entries: dictionaryEntries,
    dictationLanguage,
    state,
  });

  getLogger().verbose(
    `Transcription prompt: ${transcriptionPrompt.length} chars, apiKeyId=${transcriptionApiKeyId ?? "none"}`,
  );

  const transcribeStart = performance.now();
  let transcribeOutput: TranscribeAudioOutput;
  try {
    transcribeOutput = await transcribeRepo.transcribeAudio({
      samples,
      sampleRate,
      prompt: transcriptionPrompt,
      language: whisperLanguage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep dispatch warnings visible on the failure path: the batch session
    // surfaces this message to the user, so append the warnings to it. The
    // original rejection is preserved verbatim as the cause, including
    // non-Error rejections.
    throw new Error(
      warnings.length > 0 ? `${message} (${warnings.join("; ")})` : message,
      { cause: error },
    );
  }
  const transcribeDuration = performance.now() - transcribeStart;
  const rawTranscript = transcribeOutput.text.trim();
  // Hallucination mitigation: when the user disables the filter we preserve the
  // raw provider transcript EXACTLY (no probability gating, no phrase
  // filtering). Otherwise we drop near-certain-silence segments via
  // `gateSilentSegments` and filter known silence phrases. Long audio that is
  // split into multiple provider chunks is gated per-chunk in the repo before
  // merging, so `transcribeOutput.segments` here covers the single-segment case
  // (and is undefined, triggering a fall back to the raw text, when the
  // provider returned no verbose segments).
  const hallucinationFilterEnabled =
    state.userPrefs?.hallucinationFilterEnabled !== false;

  const sanitizedTranscript = applyHallucinationFiltering(
    rawTranscript,
    transcribeOutput.segments,
    dictationLanguage,
    hallucinationFilterEnabled,
  );

  if (rawTranscript !== sanitizedTranscript) {
    getLogger().info(
      "Removed a known silence hallucination from transcription",
    );
  }

  getLogger().info(
    `Transcription complete in ${Math.round(transcribeDuration)}ms (${rawTranscript.length} raw chars, ${sanitizedTranscript.length} sanitized chars, mode=${transcribeOutput.metadata?.transcriptionMode ?? "unknown"})`,
  );

  metadata.modelSize =
    transcribeOutput.metadata?.modelSize ||
    state.settings.aiTranscription.modelSize ||
    null;
  metadata.inferenceDevice = transcribeOutput.metadata?.inferenceDevice || null;
  metadata.transcriptionDurationMs = Math.round(transcribeDuration);
  metadata.transcriptionPrompt = transcriptionPrompt;
  metadata.transcriptionApiKeyId = transcriptionApiKeyId;
  metadata.transcriptionMode =
    transcribeOutput.metadata?.transcriptionMode || null;

  return {
    rawTranscript,
    sanitizedTranscript,
    warnings: dedup(warnings),
    metadata,
  };
};

/**
 * Post-process a raw transcript using LLM.
 * This is the second step - cleans up and formats the transcript based on tone.
 */
export const postProcessTranscript = async ({
  rawTranscript,
  toneId,
  dictationLanguage: dictationLanguageOverride,
}: PostProcessInput): Promise<PostProcessResult> => {
  const state = getAppState();

  const metadata: PostProcessMetadata = {};
  const warnings: string[] = [];

  const {
    repo: genRepo,
    apiKeyId: genApiKeyId,
    warnings: genWarnings,
  } = getGenerateTextRepo();
  warnings.push(...genWarnings);

  const tone = getToneById(state, toneId);
  const toneProcessingDisabled = tone?.shouldDisablePostProcessing ?? false;

  let processedTranscript = rawTranscript;
  if (toneProcessingDisabled) {
    getLogger().info(`Post-processing disabled for tone=${toneId}`);
    metadata.postProcessMode = "none";
  } else if (genRepo) {
    getLogger().verbose(
      `Post-processing with tone=${toneId ?? "default"}, apiKeyId=${genApiKeyId ?? "none"}`,
    );
    const dictationLanguage = dictationLanguageOverride
      ? coerceToDictationLanguage(dictationLanguageOverride)
      : await loadMyEffectiveDictationLanguage(state);
    const toneConfig = getToneConfig(state, toneId);
    getLogger().verbose(
      "Post-process language:",
      dictationLanguage,
      "toneName:",
      tone?.name ?? "unknown",
    );

    const promptInput: PostProcessingPromptInput = {
      transcript: rawTranscript,
      userName: getMyUserName(state),
      dictationLanguage,
      tone: toneConfig,
    };
    const ppSystem = buildSystemPostProcessingTonePrompt(promptInput);
    const ppPrompt = buildPostProcessingPrompt(promptInput);
    getLogger().verbose(
      "Post-process prompt length:",
      ppPrompt.length,
      "system length:",
      ppSystem.length,
    );

    const postprocessStart = performance.now();
    getLogger().verbose("Calling LLM for post-processing");
    const genOutput = await genRepo.generateText({
      system: ppSystem,
      prompt: ppPrompt,
      jsonResponse: {
        name: "transcription_cleaning",
        description: "JSON response with the processed transcription",
        schema: PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
      },
    });
    const postprocessDuration = performance.now() - postprocessStart;
    metadata.postprocessDurationMs = Math.round(postprocessDuration);

    getLogger().info(
      `Post-processing complete in ${Math.round(postprocessDuration)}ms`,
    );
    getLogger().verbose("LLM raw output length:", genOutput.text.length);

    try {
      const parsed = unwrapNestedLlmResponse(
        parsePostProcessingJson(genOutput.text) as Record<string, unknown>,
        "processedTranscription",
      );

      const validationResult = PROCESSED_TRANSCRIPTION_SCHEMA.safeParse(parsed);
      if (!validationResult.success) {
        getLogger().warning(
          "Post-processing validation failed:",
          validationResult.error.message,
        );
        warnings.push(
          `Post-processing response validation failed: ${validationResult.error.message}`,
        );
      } else {
        processedTranscript = validationResult.data.result.trim();
        getLogger().verbose(
          "Processed transcript length:",
          processedTranscript.length,
        );
      }
    } catch (e) {
      getLogger().error("Failed to parse post-processing response:", e);
      const message = (e as Error).message;
      const truncationHint = /Unterminated string/i.test(message)
        ? " The model output may have been truncated at its token limit."
        : "";
      warnings.push(
        `Failed to parse post-processing response: ${message}.${truncationHint}`,
      );
    }

    metadata.postProcessPrompt = ppPrompt;
    metadata.postProcessApiKeyId = genApiKeyId;
    metadata.postProcessMode = genOutput.metadata?.postProcessingMode || null;
    metadata.postProcessDevice = genOutput.metadata?.inferenceDevice || null;
    getLogger().verbose(
      "Post-process mode:",
      metadata.postProcessMode,
      "device:",
      metadata.postProcessDevice,
    );
  } else {
    getLogger().info("No post-processing repo configured, skipping");
    metadata.postProcessMode = "none";
  }

  return {
    transcript: processedTranscript,
    warnings: dedup(warnings),
    metadata,
  };
};

export type StoreTranscriptionInput = {
  audio: StopRecordingResponse;
  rawTranscript: string | null;
  sanitizedTranscript: string | null;
  transcript: string | null;
  transcriptionMetadata: TranscribeAudioMetadata;
  postProcessMetadata: PostProcessMetadata;
  warnings: string[];
  remoteStatus?: "sent" | "received" | null;
  remoteDeviceId?: string | null;
};

export type StoreTranscriptionOutput = {
  transcription: Transcription | null;
  wordCount: number;
};

const getSampleCount = (samples: StopRecordingResponse["samples"]): number =>
  samples ? samples.length : 0;

const getWordsAdded = (transcript: string | null): number =>
  transcript ? countWords(transcript) : 0;

const recordUsageWords = async (wordsAdded: number): Promise<void> => {
  if (wordsAdded <= 0) {
    return;
  }
  try {
    await addWordsToCurrentUser(wordsAdded);
  } catch (error) {
    console.error("Failed to update usage metrics", error);
  }
};

const persistAudioSnapshot = async (
  transcriptionId: string,
  samples: number[] | Float32Array,
  sampleRate: number,
): Promise<TranscriptionAudioSnapshot | undefined> => {
  try {
    return await invoke<TranscriptionAudioSnapshot>(
      "store_transcription_audio",
      {
        id: transcriptionId,
        samples,
        sampleRate,
      },
    );
  } catch (error) {
    console.error("Failed to persist audio snapshot", error);
    return undefined;
  }
};

const buildTranscriptionRecord = ({
  input,
  transcriptionId,
  audioSnapshot,
  transcriptionFailed,
  createdAt,
  createdByUserId,
}: {
  input: StoreTranscriptionInput;
  transcriptionId: string;
  audioSnapshot: TranscriptionAudioSnapshot | undefined;
  transcriptionFailed: boolean;
  createdAt: string;
  createdByUserId: string;
}): Transcription => ({
  id: transcriptionId,
  transcript: !transcriptionFailed
    ? (input.transcript ?? "")
    : "[Transcription Failed]",
  createdAt,
  createdByUserId,
  isDeleted: false,
  audio: audioSnapshot,
  modelSize: orNull(input.transcriptionMetadata.modelSize),
  inferenceDevice: orNull(input.transcriptionMetadata.inferenceDevice),
  rawTranscript: input.rawTranscript ?? input.transcript ?? "",
  sanitizedTranscript: orNull(input.sanitizedTranscript),
  transcriptionPrompt: orNull(input.transcriptionMetadata.transcriptionPrompt),
  postProcessPrompt: orNull(input.postProcessMetadata.postProcessPrompt),
  transcriptionApiKeyId: orNull(
    input.transcriptionMetadata.transcriptionApiKeyId,
  ),
  postProcessApiKeyId: orNull(input.postProcessMetadata.postProcessApiKeyId),
  transcriptionMode: orNull(input.transcriptionMetadata.transcriptionMode),
  postProcessMode: orNull(input.postProcessMetadata.postProcessMode),
  postProcessDevice: orNull(input.postProcessMetadata.postProcessDevice),
  transcriptionDurationMs: orNull(
    input.transcriptionMetadata.transcriptionDurationMs,
  ),
  postprocessDurationMs: orNull(
    input.postProcessMetadata.postprocessDurationMs,
  ),
  warnings: input.warnings.length > 0 ? input.warnings : null,
  remoteStatus: orNull(input.remoteStatus),
  remoteDeviceId: orNull(input.remoteDeviceId),
});

const persistTranscription = async (
  transcription: Transcription,
): Promise<Transcription | null> => {
  try {
    const stored =
      await getTranscriptionRepo().createTranscription(transcription);
    produceAppState((draft) => {
      draft.transcriptionById[stored.id] = stored;
      const existingIds = draft.transcriptions.transcriptionIds.filter(
        (identifier) => identifier !== stored.id,
      );
      draft.transcriptions.transcriptionIds = [stored.id, ...existingIds];
    });
    return stored;
  } catch (error) {
    console.error("Failed to store transcription", error);
    showErrorSnackbar("Unable to save transcription. Please try again.");
    return null;
  }
};

const purgeStaleAudioSnapshots = async (): Promise<void> => {
  try {
    const purgedIds = await getTranscriptionRepo().purgeStaleAudio();
    if (purgedIds.length === 0) {
      return;
    }
    produceAppState((draft) => {
      for (const purgedId of purgedIds) {
        const purged = draft.transcriptionById[purgedId];
        if (purged) {
          delete purged.audio;
        }
      }
    });
  } catch (error) {
    console.error("Failed to purge stale audio snapshots", error);
  }
};

export const storeTranscription = async (
  input: StoreTranscriptionInput,
): Promise<StoreTranscriptionOutput> => {
  getLogger().verbose("Storing transcription record");
  const rate = input.audio.sampleRate;
  const sampleCount = getSampleCount(input.audio.samples);

  if (rate == null || Number.isNaN(rate)) {
    getLogger().error("Received audio payload without sample rate");
    showErrorSnackbar("Recording missing sample rate. Please try again.");
    return { transcription: null, wordCount: 0 };
  }

  if (rate <= 0 || sampleCount === 0) {
    getLogger().warning(
      `Skipping store: rate=${rate}, sampleCount=${sampleCount}`,
    );
    return { transcription: null, wordCount: 0 };
  }

  const state = getAppState();
  const incognitoEnabled = orFalse(state.userPrefs?.incognitoModeEnabled);
  const includeInStats = orFalse(state.userPrefs?.incognitoModeIncludeInStats);
  const wordsAdded = getWordsAdded(input.transcript);

  if (incognitoEnabled) {
    getLogger().verbose(
      `Incognito mode: skipping storage (includeInStats=${includeInStats}, words=${wordsAdded})`,
    );
    if (wordsAdded > 0 && includeInStats) {
      await recordUsageWords(wordsAdded);
    }

    return { transcription: null, wordCount: wordsAdded };
  }

  // Coerce the samples to an Array regardless of whether the IPC layer
  // returned a plain Array or a typed-array-like. The rate<=0 / empty
  // short-circuit above already guarantees this path is non-empty.
  const payloadSamples = Array.isArray(input.audio.samples)
    ? input.audio.samples
    : Array.from(input.audio.samples ?? []);

  const transcriptionId = createId();
  const audioSnapshot = await persistAudioSnapshot(
    transcriptionId,
    payloadSamples,
    rate,
  );

  const transcriptionFailed =
    input.rawTranscript === null && input.warnings.length > 0;

  const transcription = buildTranscriptionRecord({
    input,
    transcriptionId,
    audioSnapshot,
    transcriptionFailed,
    createdAt: dayjs().toISOString(),
    createdByUserId: getMyEffectiveUserId(state),
  });

  const storedTranscription = await persistTranscription(transcription);
  if (!storedTranscription) {
    return { transcription: null, wordCount: 0 };
  }

  await recordUsageWords(wordsAdded);
  await purgeStaleAudioSnapshots();

  return { transcription: storedTranscription, wordCount: wordsAdded };
};

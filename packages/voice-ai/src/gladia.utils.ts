import {
  GladiaClient,
  type LiveV2InitRequest,
  type LiveV2LanguageConfig,
  type LiveV2SampleRate,
  type LiveV2WebSocketMessage,
} from "@gladiaio/sdk";

export const GLADIA_API_ORIGIN = "https://api.gladia.io";
export const GLADIA_WEBSOCKET_ORIGIN = "wss://api.gladia.io";
export const GLADIA_TRANSCRIPTION_MODELS = ["solaria-1"] as const;
export type GladiaTranscriptionModel =
  (typeof GLADIA_TRANSCRIPTION_MODELS)[number];

export type GladiaLanguageConfig = {
  languages: string[];
  code_switching: false;
};

export type GladiaCustomizations = {
  vocabulary: string[];
  spellingDictionary: Record<string, string[]>;
  warnings?: string[];
};

export type GladiaTranscribeAudioArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  language: string;
  model?: string | null;
  customizations?: GladiaCustomizations;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type GladiaTranscribeAudioOutput = {
  text: string;
  warnings: string[];
};

export type GladiaStreamingSession = {
  sendAudio: (audio: ArrayBuffer) => void;
  finalize: () => Promise<string>;
  cleanup: () => void;
  getWarnings: () => string[];
};

export type CreateGladiaStreamingSessionArgs = {
  apiKey: string;
  sampleRate: LiveV2SampleRate;
  language: string;
  model?: string | null;
  customizations?: GladiaCustomizations;
  onReady?: () => void;
  onConnectionInterrupted?: () => void;
  onFinalSegment?: (segment: string) => void;
  finalizeTimeoutMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POLL_TIMEOUT_MS = 7_200_000;
const DEFAULT_LIVE_FINALIZE_TIMEOUT_MS = 20_000;
const MAX_LIVE_WARNINGS = 50;
const LIVE_WARNING_LIMIT_MESSAGE =
  "Additional Gladia live-session warnings were omitted.";

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(/wss:\/\/[^\s)\]}]+/gi, "[Gladia WebSocket endpoint]")
    .replace(/\bBearer\s+[^\s,;)]+/gi, "Bearer [redacted]")
    .replace(
      /\b(token|api[_-]?key|x[-_]?gladia[-_]?key|authorization)(\s*[:=]\s*)[^\s,;)]+/gi,
      "$1$2[redacted]",
    )
    .slice(0, 500);

const requireGladiaApiKey = (apiKey: string): string => {
  const normalized = apiKey.trim();
  if (!normalized) {
    throw new Error("A Gladia API key is required.");
  }
  return normalized;
};

const deduplicate = (values: string[]): string[] => Array.from(new Set(values));

export const normalizeGladiaModel = (
  model?: string | null,
): GladiaTranscriptionModel => (model === "solaria-1" ? model : "solaria-1");

export const getGladiaModelWarning = (model?: string | null): string | null =>
  model && model !== "solaria-1"
    ? `Unsupported Gladia model “${model}” was replaced with solaria-1.`
    : null;

export const mapToGladiaLanguageConfig = (
  language?: string | null,
): GladiaLanguageConfig => {
  const normalized = language?.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return { languages: [], code_switching: false };
  }

  const base = normalized.split("-")[0];
  const gladiaLanguage = base === "yue" ? "zh" : base;
  return {
    languages: gladiaLanguage ? [gladiaLanguage] : [],
    code_switching: false,
  };
};

export const isAllowedGladiaWebSocketUrl = (candidate: string): boolean => {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "wss:" &&
      url.host === "api.gladia.io" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

export const gladiaTestIntegration = async ({
  apiKey,
}: {
  apiKey: string;
}): Promise<boolean> => {
  try {
    const normalizedApiKey = requireGladiaApiKey(apiKey);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `${GLADIA_API_ORIGIN}/v2/pre-recorded?limit=1`,
        {
          headers: { "x-gladia-key": normalizedApiKey },
          redirect: "error",
          signal: controller.signal,
        },
      );
      return response.ok;
    } finally {
      clearTimeout(abortTimer);
    }
  } catch {
    return false;
  }
};

const buildCustomVocabulary = (customizations?: GladiaCustomizations) => {
  const vocabulary = customizations?.vocabulary ?? [];
  return vocabulary.length > 0
    ? {
        custom_vocabulary: true,
        custom_vocabulary_config: {
          vocabulary,
          default_intensity: 0.4,
        },
      }
    : {};
};

const buildCustomSpelling = (customizations?: GladiaCustomizations) => {
  const spellingDictionary = customizations?.spellingDictionary ?? {};
  return Object.keys(spellingDictionary).length > 0
    ? {
        custom_spelling: true,
        custom_spelling_config: {
          spelling_dictionary: spellingDictionary,
        },
      }
    : {};
};

const buildLiveConfig = ({
  sampleRate,
  language,
  model,
  customizations,
}: Pick<
  CreateGladiaStreamingSessionArgs,
  "sampleRate" | "language" | "model" | "customizations"
>): LiveV2InitRequest => ({
  model: normalizeGladiaModel(model),
  encoding: "wav/pcm",
  bit_depth: 16,
  sample_rate: sampleRate,
  channels: 1,
  endpointing: 0.3,
  maximum_duration_without_endpointing: 30,
  language_config: mapToGladiaLanguageConfig(language) as LiveV2LanguageConfig,
  realtime_processing: {
    ...buildCustomVocabulary(customizations),
    ...buildCustomSpelling(customizations),
  },
  messages_config: {
    receive_partial_transcripts: true,
    receive_final_transcripts: true,
    receive_errors: true,
    receive_lifecycle_events: true,
    receive_post_processing_events: true,
  },
});

export class GladiaTranscriptAccumulator {
  private readonly order: string[] = [];
  private readonly segments = new Map<
    string,
    { text: string; isFinal: boolean }
  >();
  private authoritativeText: string | null = null;

  update(
    id: string,
    text: string,
    isFinal: boolean,
  ): { committedSegment: string | null } {
    const normalizedText = text.trim();
    const existing = this.segments.get(id);
    if (existing?.isFinal) {
      return { committedSegment: null };
    }

    if (!existing) {
      this.order.push(id);
    }
    this.segments.set(id, { text: normalizedText, isFinal });

    return {
      committedSegment: isFinal && normalizedText ? normalizedText : null,
    };
  }

  setAuthoritativeText(text: string): void {
    const normalizedText = text.trim();
    if (normalizedText) {
      this.authoritativeText = normalizedText;
    }
  }

  getFinalText(): string {
    if (this.authoritativeText) {
      return this.authoritativeText;
    }
    return this.order
      .map((id) => this.segments.get(id))
      .filter(
        (segment): segment is { text: string; isFinal: true } =>
          segment?.isFinal === true && Boolean(segment.text),
      )
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  }

  getBestEffortText(): string {
    const finalText = this.getFinalText();
    if (finalText) {
      return finalText;
    }
    return this.order
      .map((id) => this.segments.get(id)?.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
  }
}

const getMessageError = (message: LiveV2WebSocketMessage): string | null => {
  if (!("error" in message) || !message.error) {
    return null;
  }
  return typeof message.error === "object" && "message" in message.error
    ? String(message.error.message)
    : String(message.error);
};

const waitBeforeDeadline = async (
  promise: Promise<void>,
  deadline: number,
): Promise<boolean> => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return false;
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), remainingMs);
    });
    return await Promise.race([promise.then(() => true), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export const createGladiaStreamingSession = ({
  apiKey,
  sampleRate,
  language,
  model,
  customizations,
  onReady,
  onConnectionInterrupted,
  onFinalSegment,
  finalizeTimeoutMs = DEFAULT_LIVE_FINALIZE_TIMEOUT_MS,
}: CreateGladiaStreamingSessionArgs): GladiaStreamingSession => {
  const client = new GladiaClient({
    apiKey: requireGladiaApiKey(apiKey),
    httpRetry: { maxAttempts: 3 },
    httpTimeout: 10_000,
    wsRetry: {
      maxAttemptsPerConnection: 3,
      maxConnections: 4,
    },
    wsTimeout: 10_000,
    liveTimeouts: { delete: 10_000 },
  });
  const liveClient = client.liveV2();
  const session = liveClient.startSession(
    buildLiveConfig({ sampleRate, language, model, customizations }),
  );
  // Subscribe before cleanup can abort initialization. If the create response
  // has already won the race, this preserves its ID so remote deletion can
  // still run even when session.sessionId was not populated at cleanup time.
  const sessionIdPromise = session
    .getSessionId()
    .then((sessionId) => sessionId || null)
    .catch(() => null);
  const transcript = new GladiaTranscriptAccumulator();
  const modelWarning = getGladiaModelWarning(model);
  const initialWarnings = deduplicate([
    ...(customizations?.warnings ?? []),
    ...(modelWarning ? [modelWarning] : []),
  ]);
  const warnings = initialWarnings.slice(0, MAX_LIVE_WARNINGS - 1);
  const warningSet = new Set(warnings);
  if (initialWarnings.length > warnings.length) {
    warnings.push(LIVE_WARNING_LIMIT_MESSAGE);
    warningSet.add(LIVE_WARNING_LIMIT_MESSAGE);
  }
  const addWarning = (warning: string) => {
    if (warningSet.has(warning)) {
      return;
    }
    if (warnings.length >= MAX_LIVE_WARNINGS - 1) {
      if (!warningSet.has(LIVE_WARNING_LIMIT_MESSAGE)) {
        warnings.push(LIVE_WARNING_LIMIT_MESSAGE);
        warningSet.add(LIVE_WARNING_LIMIT_MESSAGE);
      }
      return;
    }
    warnings.push(warning);
    warningSet.add(warning);
  };
  let disposed = false;
  let acceptingAudio = true;
  let endpointValidated = false;
  let validationSettled = false;
  let validationResolve: (() => void) | null = null;
  let ended = false;
  let endedResolve: (() => void) | null = null;
  let finalizePromise: Promise<string> | null = null;
  let deletionPromise: Promise<void> | null = null;

  const validationPromise = new Promise<void>((resolve) => {
    validationResolve = resolve;
  });
  const endedPromise = new Promise<void>((resolve) => {
    endedResolve = resolve;
  });

  const finishValidation = () => {
    if (!validationSettled) {
      validationSettled = true;
      validationResolve?.();
      validationResolve = null;
    }
  };

  const finishEnded = () => {
    finishValidation();
    if (!ended) {
      ended = true;
      endedResolve?.();
      endedResolve = null;
    }
  };

  const endSessionSafely = () => {
    try {
      session.endSession();
    } catch (error) {
      addWarning(`Gladia session shutdown failed: ${errorMessage(error)}`);
    }
  };

  const deleteRemoteSession = (): Promise<void> => {
    if (deletionPromise) {
      return deletionPromise;
    }
    deletionPromise = (async () => {
      const sessionId = session.sessionId ?? (await sessionIdPromise);
      if (!sessionId) {
        return;
      }
      try {
        const deleted = await liveClient.delete(sessionId);
        if (!deleted) {
          addWarning("Gladia live data deletion was not acknowledged.");
        }
      } catch (error) {
        addWarning(`Gladia live data deletion failed: ${errorMessage(error)}`);
      }
    })();
    return deletionPromise;
  };

  session.on("started", (response) => {
    if (disposed) {
      return;
    }
    endpointValidated =
      typeof response?.url === "string" &&
      isAllowedGladiaWebSocketUrl(response.url);
    finishValidation();
    if (!endpointValidated) {
      addWarning("Gladia returned an untrusted WebSocket endpoint.");
      endSessionSafely();
      finishEnded();
    }
  });

  session.on("connecting", () => {
    if (!disposed) {
      onConnectionInterrupted?.();
    }
  });

  session.on("connected", () => {
    if (!disposed) {
      onReady?.();
    }
  });

  session.on("message", (message) => {
    if (disposed) {
      return;
    }

    const providerError = getMessageError(message);
    if (providerError) {
      addWarning(`Gladia reported an error: ${errorMessage(providerError)}`);
    }

    if (message.type === "transcript") {
      const data = message.data;
      if (
        !data ||
        typeof data.id !== "string" ||
        typeof data.is_final !== "boolean" ||
        !data.utterance ||
        typeof data.utterance.text !== "string"
      ) {
        addWarning("Gladia returned a malformed transcript message.");
        return;
      }
      const update = transcript.update(
        data.id,
        data.utterance.text,
        data.is_final,
      );
      if (update.committedSegment) {
        onFinalSegment?.(update.committedSegment);
      }
    } else if (message.type === "post_final_transcript") {
      const fullTranscript = message.data?.transcription?.full_transcript;
      if (typeof fullTranscript === "string") {
        transcript.setAuthoritativeText(fullTranscript);
      } else {
        addWarning("Gladia returned a malformed post-final transcript.");
      }
    } else if (message.type === "post_transcript") {
      if (typeof message.data?.full_transcript === "string") {
        transcript.setAuthoritativeText(message.data.full_transcript);
      } else {
        addWarning("Gladia returned a malformed post transcript.");
      }
    }
  });

  session.on("error", (error) => {
    if (!disposed) {
      addWarning(`Gladia connection error: ${errorMessage(error)}`);
    }
  });

  session.once("ended", ({ code, reason }) => {
    onConnectionInterrupted?.();
    if (code !== 1000 && !disposed) {
      const safeReason = reason ? errorMessage(reason) : "";
      const reasonSuffix = safeReason ? `: ${safeReason}` : "";
      addWarning(
        `Gladia live session ended unexpectedly (${code}${reasonSuffix}).`,
      );
    }
    finishEnded();
  });

  const finalize = (): Promise<string> => {
    if (finalizePromise) {
      return finalizePromise;
    }
    acceptingAudio = false;

    finalizePromise = (async () => {
      const budgetMs = Number.isFinite(finalizeTimeoutMs)
        ? Math.min(
            DEFAULT_LIVE_FINALIZE_TIMEOUT_MS,
            Math.max(1, finalizeTimeoutMs),
          )
        : DEFAULT_LIVE_FINALIZE_TIMEOUT_MS;
      const deadline = Date.now() + budgetMs;

      try {
        // Calling the SDK's stopRecording() while its initialization request is
        // still pending changes its state to "ending". In that state the SDK
        // skips the `started` event but can still open the returned WebSocket,
        // bypassing our endpoint check. Wait for validation before stopping.
        if (!ended && !endpointValidated) {
          const validationCompleted = await waitBeforeDeadline(
            validationPromise,
            deadline,
          );
          if (!validationCompleted) {
            addWarning(
              "Gladia initialization timed out before endpoint validation.",
            );
            endSessionSafely();
            finishEnded();
          }
        }

        if (!ended && endpointValidated) {
          session.stopRecording();
          const finalizedBeforeDeadline = await waitBeforeDeadline(
            endedPromise,
            deadline,
          );
          if (!finalizedBeforeDeadline) {
            addWarning(
              "Gladia finalization timed out; using finalized text received so far.",
            );
            endSessionSafely();
            finishEnded();
          }
        }
      } catch (error) {
        addWarning(`Gladia finalization failed: ${errorMessage(error)}`);
        endSessionSafely();
        finishEnded();
      }

      await deleteRemoteSession();
      const finalText = transcript.getFinalText();
      if (finalText) {
        return finalText;
      }

      const bestEffortText = transcript.getBestEffortText();
      if (bestEffortText) {
        addWarning(
          "Gladia returned only a partial transcript before the session ended.",
        );
      }
      return bestEffortText;
    })();
    return finalizePromise;
  };

  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    acceptingAudio = false;
    endSessionSafely();
    finishEnded();
    void deleteRemoteSession();
  };

  return {
    sendAudio: (audio) => {
      if (!disposed && acceptingAudio) {
        session.sendAudio(audio);
      }
    },
    finalize,
    cleanup,
    getWarnings: () => deduplicate(warnings),
  };
};

type GladiaPollingControls = {
  intervalMs: number;
  timeoutMs: number;
};

const normalizeGladiaPollingControls = (
  pollIntervalMs: number,
  timeoutMs: number,
): GladiaPollingControls => {
  const normalizedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.min(DEFAULT_POLL_TIMEOUT_MS, Math.max(1, timeoutMs))
    : DEFAULT_POLL_TIMEOUT_MS;
  const requestedPollIntervalMs = Number.isFinite(pollIntervalMs)
    ? Math.max(0, pollIntervalMs)
    : DEFAULT_POLL_INTERVAL_MS;
  return {
    intervalMs: Math.min(
      requestedPollIntervalMs,
      MAX_POLL_INTERVAL_MS,
      normalizedTimeoutMs,
    ),
    timeoutMs: normalizedTimeoutMs,
  };
};

const createGladiaAudioFile = (blob: ArrayBuffer | Buffer): File => {
  let audioBlobPart: ArrayBuffer;
  if (blob instanceof ArrayBuffer) {
    audioBlobPart = blob;
  } else {
    // Node Buffers may be backed by SharedArrayBuffer, which is not a
    // BlobPart. Desktop-owned ArrayBuffers do not need this defensive copy.
    const copied = new Uint8Array(blob.byteLength);
    copied.set(blob);
    audioBlobPart = copied.buffer;
  }
  return new File([audioBlobPart], "audio.wav", { type: "audio/wav" });
};

const getGladiaBatchWarnings = (
  model: string | null | undefined,
  customizations: GladiaCustomizations | undefined,
): string[] => {
  const warnings = [...(customizations?.warnings ?? [])];
  const modelWarning = getGladiaModelWarning(model);
  if (modelWarning) {
    warnings.push(modelWarning);
  }
  return warnings;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireAudioUrl = (upload: unknown): string => {
  if (
    !isRecord(upload) ||
    typeof upload.audio_url !== "string" ||
    !upload.audio_url
  ) {
    throw new Error("Gladia upload returned an invalid audio URL.");
  }
  return upload.audio_url;
};

const requireJobId = (init: unknown): string => {
  if (!isRecord(init) || typeof init.id !== "string" || !init.id) {
    throw new Error("Gladia create returned an invalid transcription ID.");
  }
  return init.id;
};

const requireTranscriptionRecord = (
  result: unknown,
): Record<string, unknown> => {
  if (!isRecord(result)) {
    throw new Error("Gladia polling returned an invalid result.");
  }
  const transcriptionResult = result.result;
  if (!isRecord(transcriptionResult)) {
    throw new Error("Gladia completed without a transcription result.");
  }
  const transcription = transcriptionResult.transcription;
  if (!isRecord(transcription)) {
    throw new Error("Gladia completed without a transcription result.");
  }
  return transcription;
};

const getFullTranscript = (transcription: Record<string, unknown>): string => {
  const fullTranscript = transcription.full_transcript;
  if (fullTranscript == null) {
    return "";
  }
  if (typeof fullTranscript !== "string") {
    throw new TypeError("Gladia returned a malformed full transcript.");
  }
  return fullTranscript.trim();
};

const getUtteranceTranscript = (
  transcription: Record<string, unknown>,
): string => {
  const utterances = transcription.utterances;
  if (utterances == null) {
    return "";
  }
  if (!Array.isArray(utterances)) {
    throw new TypeError("Gladia returned malformed transcript utterances.");
  }
  return utterances
    .map((utterance) => {
      if (!isRecord(utterance) || typeof utterance.text !== "string") {
        throw new TypeError(
          "Gladia returned a malformed transcript utterance.",
        );
      }
      return utterance.text.trim();
    })
    .filter(Boolean)
    .join(" ");
};

const extractGladiaBatchTranscript = (result: unknown): string => {
  const transcription = requireTranscriptionRecord(result);
  const fullTranscript = getFullTranscript(transcription);
  const utteranceTranscript = getUtteranceTranscript(transcription);
  return fullTranscript || utteranceTranscript;
};

const reportBatchCleanupWarning = (
  warning: string,
  warnings: string[],
  primaryError: unknown,
): void => {
  if (primaryError) {
    console.warn(warning);
  } else {
    warnings.push(warning);
  }
};

const deleteGladiaBatchJob = async ({
  jobId,
  deleteJob,
  warnings,
  primaryError,
}: {
  jobId: string | null;
  deleteJob: (id: string) => Promise<boolean>;
  warnings: string[];
  primaryError: unknown;
}): Promise<void> => {
  if (!jobId) {
    return;
  }
  try {
    const deleted = await deleteJob(jobId);
    if (deleted) {
      return;
    }
    reportBatchCleanupWarning(
      "Gladia pre-recorded data deletion was not acknowledged.",
      warnings,
      primaryError,
    );
  } catch (error) {
    reportBatchCleanupWarning(
      `Gladia pre-recorded data deletion failed: ${errorMessage(error)}`,
      warnings,
      primaryError,
    );
  }
};

export const gladiaTranscribeAudio = async ({
  apiKey,
  blob,
  language,
  model,
  customizations,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
}: GladiaTranscribeAudioArgs): Promise<GladiaTranscribeAudioOutput> => {
  const polling = normalizeGladiaPollingControls(pollIntervalMs, timeoutMs);
  const client = new GladiaClient({
    apiKey: requireGladiaApiKey(apiKey),
    httpRetry: { maxAttempts: 3 },
    httpTimeout: 10_000,
    prerecordedTimeouts: {
      uploadFile: 300_000,
      create: 60_000,
      get: 10_000,
      delete: 10_000,
      poll: polling.timeoutMs,
    },
  }).preRecordedV2();
  const audioFile = createGladiaAudioFile(blob);
  const warnings = getGladiaBatchWarnings(model, customizations);
  let jobId: string | null = null;
  let primaryError: unknown = null;

  try {
    const upload = await client.uploadFile(audioFile);
    const init = await client.createUntyped({
      audio_url: requireAudioUrl(upload),
      model: normalizeGladiaModel(model),
      language_config: mapToGladiaLanguageConfig(language),
      ...buildCustomVocabulary(customizations),
      ...buildCustomSpelling(customizations),
    });
    jobId = requireJobId(init);
    const result = await client.poll(jobId, {
      interval: polling.intervalMs,
      timeout: polling.timeoutMs,
    });
    return { text: extractGladiaBatchTranscript(result), warnings };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await deleteGladiaBatchJob({
      jobId,
      deleteJob: (id) => client.delete(id),
      warnings,
      primaryError,
    });
  }
};

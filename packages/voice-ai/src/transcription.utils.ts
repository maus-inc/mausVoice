import { countWords, retry } from "@maus-inc/utilities";

export type TranscriptionSegment = {
  text: string;
  noSpeechProb?: number;
  avgLogprob?: number;
  /** Segment bounds in seconds from the start of the submitted audio. */
  start?: number;
  end?: number;
};

export type TranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
  segments?: TranscriptionSegment[];
};

/**
 * Flatten a chat/content part payload into a plain string. Shared by every
 * provider util (previously copy-pasted into each `*utils.ts`).
 */
export const contentToString = (
  content: string | { type: string; text?: string }[] | null | undefined,
): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text ?? "";
      }
      return "";
    })
    .join("")
    .trim();
};

/**
 * Defensively read an OpenAI-compatible transcription response. The SDK types
 * `create` as a union, so we read `segments[].no_speech_prob` and
 * `segments[].avg_logprob` ourselves to support issue #54's probability-gated
 * silence handling regardless of the requested `response_format`.
 */
export function parseSdkTranscription(
  response: unknown,
): TranscribeAudioOutput {
  if (typeof response !== "object" || response === null) {
    throw new Error("Transcription failed: invalid response payload");
  }

  const record = response as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : undefined;

  if (!text) {
    throw new Error("Transcription failed: missing or empty text");
  }

  let segments: TranscriptionSegment[] | undefined;
  if (Array.isArray(record.segments)) {
    const allSegmentsValid = record.segments.every(
      (s): s is Record<string, unknown> =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as Record<string, unknown>).text === "string",
    );
    if (allSegmentsValid) {
      segments = record.segments.map((segment) => {
        const s = segment as Record<string, unknown>;
        return {
          text: s.text as string,
          noSpeechProb:
            typeof s.no_speech_prob === "number" ? s.no_speech_prob : undefined,
          avgLogprob:
            typeof s.avg_logprob === "number" ? s.avg_logprob : undefined,
          start: typeof s.start === "number" ? s.start : undefined,
          end: typeof s.end === "number" ? s.end : undefined,
        };
      });
    }
  }

  return {
    text,
    wordsUsed: countWords(text),
    segments,
  };
}

export type SdkTranscriptionBody = {
  file: unknown;
  model: string;
  prompt?: string;
  language?: string;
  response_format: "verbose_json" | "json";
};

/**
 * Shared transcription runner for OpenAI-compatible SDKs (OpenAI, Groq, ...).
 * Wraps the provider's `audio.transcriptions.create` in the standard retry /
 * normalize / parse pipeline so each provider only supplies its client and the
 * `response_format` it supports.
 */
export async function runSdkTranscription(
  transcribe: (body: SdkTranscriptionBody) => Promise<unknown>,
  params: SdkTranscriptionBody,
): Promise<TranscribeAudioOutput> {
  return retry({
    retries: 3,
    fn: async () => {
      const response = await transcribe({
        ...params,
        language:
          params.language && params.language !== "auto"
            ? params.language
            : undefined,
      });
      return parseSdkTranscription(response);
    },
  });
}

import { countWords, retry } from "@maus-inc/utilities";

export type TranscriptionSegment = {
  text: string;
  noSpeechProb?: number;
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
 * `create` as a union, so we read `segments[].no_speech_prob` ourselves to
 * support issue #54's probability-gated silence handling regardless of the
 * requested `response_format`.
 */
export function parseSdkTranscription(response: unknown): TranscribeAudioOutput {
  const verbose = response as unknown as {
    text?: string;
    segments?: Array<{ text?: string; no_speech_prob?: number }>;
  };

  if (!verbose.text) {
    throw new Error("Transcription failed");
  }

  const segments = verbose.segments
    ? verbose.segments.map((segment) => ({
        text: segment.text ?? "",
        noSpeechProb: segment.no_speech_prob,
      }))
    : undefined;

  return {
    text: verbose.text,
    wordsUsed: countWords(verbose.text),
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

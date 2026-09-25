import { toFile } from "openai/uploads";
import type { FileLike } from "openai/uploads";
import { countWords, retry } from "@maus-inc/utilities";

export type TranscribeAudioClientShape = {
  audio: {
    transcriptions: {
      create: (
        args: {
          file: FileLike;
          model: string;
          prompt?: string;
          language?: string;
        },
        options?: { signal?: AbortSignal },
      ) => Promise<{ text?: string }>;
    };
  };
};

export type OpenAICompatibleTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export type OpenAICompatibleTranscribeAudioArgs = {
  client: TranscribeAudioClientShape;
  blob: ArrayBuffer | Buffer;
  model: string;
  ext: string;
  prompt?: string;
  language?: string;
  signal?: AbortSignal;
};

export const openaiCompatibleTranscribeAudio = async ({
  client,
  blob,
  model,
  ext,
  prompt,
  language,
  signal,
}: OpenAICompatibleTranscribeAudioArgs): Promise<OpenAICompatibleTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    isRetryable: () => !signal?.aborted,
    fn: async () => {
      const file = await toFile(blob, `audio.${ext}`);
      const response = await client.audio.transcriptions.create(
        {
          file,
          model,
          prompt,
          language: language && language !== "auto" ? language : undefined,
        },
        { signal },
      );

      if (!response.text) {
        throw new Error("Transcription failed");
      }

      return { text: response.text, wordsUsed: countWords(response.text) };
    },
  });
};

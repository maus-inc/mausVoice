import { toFile } from "openai/uploads";
import type { FileLike } from "openai/uploads";
import { countWords, retry, toHttpError } from "@maus-inc/utilities";

export type TranscribeAudioClientShape = {
  audio: {
    transcriptions: {
      create: (args: {
        file: FileLike;
        model: string;
        prompt?: string;
        language?: string;
      }) => Promise<{ text?: string }>;
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
};

export const openaiCompatibleTranscribeAudio = async ({
  client,
  blob,
  model,
  ext,
  prompt,
  language,
}: OpenAICompatibleTranscribeAudioArgs): Promise<OpenAICompatibleTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      try {
        const file = await toFile(blob, `audio.${ext}`);
        const response = await client.audio.transcriptions.create({
          file,
          model,
          prompt,
          language: language && language !== "auto" ? language : undefined,
        });

        if (!response.text) {
          // The provider answered 2xx with an empty body, so there is no HTTP
          // status to report; this stays a plain error rather than an
          // invented one.
          throw new Error("Transcription failed: no text in response");
        }

        return { text: response.text, wordsUsed: countWords(response.text) };
      } catch (error) {
        // Normalise the provider SDK's APIError into the shared HttpError so
        // the retry policy reads the status as data for every provider. A
        // transport failure still surfaces as the original error.
        throw toHttpError(error);
      }
    },
  });
};

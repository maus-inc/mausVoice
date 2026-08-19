import { retry, countWords } from "@maus-inc/utilities";
import { postTranscriptionRequest } from "./shared.utils";

export type SpeachesTestIntegrationArgs = {
  baseUrl: string;
};

export const speachesTestIntegration = async ({
  baseUrl,
}: SpeachesTestIntegrationArgs): Promise<boolean> => {
  const url = baseUrl.replace(/\/$/, "");
  const response = await fetch(`${url}/health`);
  return response.ok;
};

export type SpeachesTranscriptionArgs = {
  baseUrl: string;
  model: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type SpeachesTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const speachesTranscribeAudio = async ({
  baseUrl,
  model,
  blob,
  ext,
  prompt,
  language,
}: SpeachesTranscriptionArgs): Promise<SpeachesTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const url = baseUrl.replace(/\/$/, "");
      const text = await postTranscriptionRequest({
        url: `${url}/v1/audio/transcriptions`,
        blob,
        ext,
        model,
        prompt,
        language,
        label: "Speaches",
      });
      return { text, wordsUsed: countWords(text) };
    },
  });
};

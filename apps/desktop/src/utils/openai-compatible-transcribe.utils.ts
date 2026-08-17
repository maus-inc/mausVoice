import { fetch } from "@tauri-apps/plugin-http";

export type OpenAICompatibleTranscriptionArgs = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  blob: ArrayBuffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type OpenAICompatibleTranscriptionSegment = {
  text: string;
  noSpeechProb?: number;
};

export type OpenAICompatibleTranscribeAudioOutput = {
  text: string;
  segments?: OpenAICompatibleTranscriptionSegment[];
};

export const openaiCompatibleTranscribeAudio = async ({
  baseUrl,
  model,
  apiKey,
  blob,
  ext,
  prompt,
  language,
}: OpenAICompatibleTranscriptionArgs): Promise<OpenAICompatibleTranscribeAudioOutput> => {
  const url = baseUrl.replace(/\/$/, "");

  const formData = new FormData();
  const file = new Blob([blob], { type: `audio/${ext}` });
  formData.append("file", file, `audio.${ext}`);
  formData.append("model", model);
  if (prompt) {
    formData.append("prompt", prompt);
  }
  if (language && language !== "auto") {
    formData.append("language", language);
  }
  // Request verbose output so `segments[].no_speech_prob` is returned, enabling
  // issue #54's probability-gated silence handling. Endpoints that don't
  // support it simply ignore the field and return plain `text`, so the defensive
  // parse below keeps the existing behavior.
  formData.append("response_format", "verbose_json");

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${url}/audio/transcriptions`, {
    method: "POST",
    body: formData,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `OpenAI Compatible transcription failed: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    text?: string;
    segments?: Array<{ text?: string; no_speech_prob?: number }>;
  };

  if (!data.text) {
    throw new Error("Transcription failed: no text in response");
  }

  const segments = data.segments
    ? data.segments.map((segment) => ({
        text: segment.text ?? "",
        noSpeechProb: segment.no_speech_prob,
      }))
    : undefined;

  return { text: data.text, segments };
};

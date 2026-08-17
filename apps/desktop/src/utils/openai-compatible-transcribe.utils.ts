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

  // Arbitrary user-configured servers vary widely. We default to `json` (the
  // safest, most broadly supported format) rather than `verbose_json`, which
  // strict servers reject with a 4xx "unsupported format" error. When that
  // happens we retry once WITHOUT `response_format` instead of failing the
  // whole transcription. Servers that do return verbose segments still get
  // `no_speech_prob` parsed below when they accept the `json` request.
  const buildBody = (includeResponseFormat: boolean): FormData => {
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
    if (includeResponseFormat) {
      formData.append("response_format", "json");
    }
    return formData;
  };

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const send = (includeResponseFormat: boolean) =>
    fetch(`${url}/audio/transcriptions`, {
      method: "POST",
      body: buildBody(includeResponseFormat),
      headers,
    });

  const response = await send(true);
  let finalResponse = response;
  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => "");
    const isUnsupportedFormatError =
      response.status >= 400 &&
      response.status < 500 &&
      /response[_\s-]?format|verbose_json|unsupported/i.test(errorText);
    if (isUnsupportedFormatError) {
      // Retry once without `response_format` rather than repeating the same
      // deterministic 4xx three times.
      finalResponse = await send(false);
    }
  }

  if (!finalResponse.ok) {
    const errorText = await finalResponse
      .text()
      .catch(() => "Unknown error");
    throw new Error(
      `OpenAI Compatible transcription failed: ${finalResponse.status} - ${errorText}`,
    );
  }

  const data = (await finalResponse.json()) as {
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

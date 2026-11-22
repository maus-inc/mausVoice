export type TranscriptionFormDataArgs = {
  blob: BlobPart;
  ext: string;
  model: string;
  prompt?: string;
  language?: string;
  responseFormat?: string;
};

/**
 * Build the multipart body the OpenAI-compatible transcription endpoints take.
 * `language: "auto"` is omitted rather than sent, because those servers read it
 * as a language code and reject it.
 */
export const buildTranscriptionFormData = ({
  blob,
  ext,
  model,
  prompt,
  language,
  responseFormat,
}: TranscriptionFormDataArgs): FormData => {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([blob], { type: `audio/${ext}` }),
    `audio.${ext}`,
  );
  formData.append("model", model);
  if (prompt) {
    formData.append("prompt", prompt);
  }
  if (language && language !== "auto") {
    formData.append("language", language);
  }
  if (responseFormat) {
    formData.append("response_format", responseFormat);
  }
  return formData;
};

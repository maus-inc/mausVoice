/** Build the common multipart payload accepted by local transcription servers. */
export const buildTranscriptionForm = ({
  blob,
  ext,
  model,
  prompt,
  language,
}: {
  blob: ArrayBuffer;
  ext: string;
  model: string;
  prompt?: string;
  language?: string;
}): FormData => {
  const formData = new FormData();
  const file = new Blob([blob], { type: `audio/${ext}` });
  formData.append("file", file, `audio.${ext}`);
  formData.append("model", model);
  if (prompt) formData.append("prompt", prompt);
  if (language && language !== "auto") formData.append("language", language);
  return formData;
};

export type TranscriptionFormDataArgs = {
  blob: ArrayBuffer | ArrayBufferView;
  ext: string;
  model: string;
  prompt?: string;
  language?: string;
  responseFormat?: string;
};

// A Node `Buffer` carries an `ArrayBufferLike` that may be shared, which is not
// a `BlobPart`. Copying the viewed range keeps the bytes and the type.
const toAudioFile = (
  blob: ArrayBuffer | ArrayBufferView,
  ext: string,
): Blob => {
  const part =
    blob instanceof ArrayBuffer
      ? blob
      : new Uint8Array(
          blob.buffer as ArrayBuffer,
          blob.byteOffset,
          blob.byteLength,
        );
  return new Blob([part], { type: `audio/${ext}` });
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
  formData.append("file", toAudioFile(blob, ext), `audio.${ext}`);
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

import { describe, expect, it } from "vitest";
import { buildTranscriptionFormData } from "./transcription-form";

const readForm = async (form: FormData) => {
  const entries = new Map<string, unknown>();
  for (const [key, value] of form.entries()) {
    entries.set(key, value);
  }
  return entries;
};

describe("buildTranscriptionFormData", () => {
  it("names the upload after the extension and carries the model", async () => {
    const form = buildTranscriptionFormData({
      blob: new Uint8Array([1, 2, 3]),
      ext: "wav",
      model: "whisper-1",
    });
    const entries = await readForm(form);
    const file = entries.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    expect(entries.get("model")).toBe("whisper-1");
  });

  it("copies only the viewed range when the bytes sit inside a larger buffer", async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const entries = await readForm(
      buildTranscriptionFormData({
        blob: new Uint8Array(backing.buffer, 2, 3),
        ext: "wav",
        model: "whisper-1",
      }),
    );
    const file = entries.get("file") as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("copies a shared-backed view, which BlobPart does not accept directly", async () => {
    const shared = new SharedArrayBuffer(3);
    new Uint8Array(shared).set([4, 5, 6]);
    const entries = await readForm(
      buildTranscriptionFormData({
        blob: new Uint8Array(shared),
        ext: "wav",
        model: "whisper-1",
      }),
    );
    const file = entries.get("file") as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([4, 5, 6]),
    );
  });

  it("omits an auto language instead of sending it", async () => {
    const entries = await readForm(
      buildTranscriptionFormData({
        blob: new ArrayBuffer(4),
        ext: "webm",
        model: "whisper-1",
        language: "auto",
      }),
    );
    expect(entries.has("language")).toBe(false);
  });

  it("keeps a concrete language, a prompt and a response format", async () => {
    const entries = await readForm(
      buildTranscriptionFormData({
        blob: new ArrayBuffer(4),
        ext: "mp3",
        model: "whisper-1",
        language: "de",
        prompt: "Berlin",
        responseFormat: "verbose_json",
      }),
    );
    expect(entries.get("language")).toBe("de");
    expect(entries.get("prompt")).toBe("Berlin");
    expect(entries.get("response_format")).toBe("verbose_json");
  });
});

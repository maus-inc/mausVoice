import { describe, expect, it } from "vitest";
import { buildTranscriptionForm } from "./transcription-form.utils";

describe("buildTranscriptionForm", () => {
  it("encodes the audio file and optional transcription fields", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const form = buildTranscriptionForm({
      blob: bytes.buffer,
      ext: "wav",
      model: "whisper",
      prompt: "names",
      language: "es",
    });
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
    expect(form.get("model")).toBe("whisper");
    expect(form.get("prompt")).toBe("names");
    expect(form.get("language")).toBe("es");
  });

  it("omits an empty prompt and the automatic language sentinel", () => {
    const form = buildTranscriptionForm({
      blob: new ArrayBuffer(0),
      ext: "mp3",
      model: "model",
      prompt: "",
      language: "auto",
    });
    expect(form.has("prompt")).toBe(false);
    expect(form.has("language")).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  openaiCompatibleTranscribeAudio,
  type TranscribeAudioClientShape,
} from "./openai-compatible-transcribe.utils";

const clientWith = (
  create: TranscribeAudioClientShape["audio"]["transcriptions"]["create"],
): TranscribeAudioClientShape => ({ audio: { transcriptions: { create } } });

describe("openaiCompatibleTranscribeAudio cancellation", () => {
  it("passes the signal to the SDK request options", async () => {
    const create = vi.fn(async () => ({ text: "hello world" }));
    const controller = new AbortController();

    const result = await openaiCompatibleTranscribeAudio({
      client: clientWith(create),
      blob: new ArrayBuffer(8),
      model: "whisper",
      ext: "wav",
      signal: controller.signal,
    });

    expect(result).toEqual({ text: "hello world", wordsUsed: 2 });
    expect(create).toHaveBeenCalledWith(expect.any(Object), {
      signal: controller.signal,
    });
  });

  it("never builds or sends a request once aborted", async () => {
    const create = vi.fn(async () => ({ text: "unused" }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      openaiCompatibleTranscribeAudio({
        client: clientWith(create),
        blob: new ArrayBuffer(8),
        model: "whisper",
        ext: "wav",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not retry after the signal aborts mid-request", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(
      openaiCompatibleTranscribeAudio({
        client: clientWith(create),
        blob: new ArrayBuffer(8),
        model: "whisper",
        ext: "wav",
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

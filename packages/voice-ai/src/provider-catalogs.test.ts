import { describe, expect, it, vi } from "vitest";
import { CLAUDE_MODELS } from "./claude.utils";
import { DEEPSEEK_MODELS } from "./deepseek.utils";
import { elevenlabsTranscribeAudio } from "./elevenlabs.utils";
import {
  GEMINI_GENERATE_TEXT_MODELS,
  GEMINI_TRANSCRIPTION_MODELS,
} from "./gemini.utils";
import { xaiTranscribeAudio } from "./xai.utils";

describe("provider fallback catalogs", () => {
  it("contains current Claude, DeepSeek, and Gemini fallbacks", () => {
    expect(CLAUDE_MODELS).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-5",
      "claude-fable-5",
    ]);
    expect(DEEPSEEK_MODELS).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(GEMINI_GENERATE_TEXT_MODELS).toContain("gemini-3.7-flash");
    expect(GEMINI_TRANSCRIPTION_MODELS).toContain("gemini-3.7-flash");
  });
});

describe("current speech APIs", () => {
  it("uses xAI's model-less STT contract and appends the file last", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      xaiTranscribeAudio({
        apiKey: "xai-key",
        blob: new ArrayBuffer(4),
        ext: "wav",
        language: "en",
        customFetch,
      }),
    ).resolves.toEqual({ text: "hello", wordsUsed: 1 });

    const [url, init] = customFetch.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/stt");
    const body = init?.body as FormData;
    expect(Array.from(body.keys())).toEqual(["format", "language", "file"]);
    expect(body.has("model")).toBe(false);
  });

  it("uses ElevenLabs Scribe v2", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await elevenlabsTranscribeAudio({
      apiKey: "eleven-key",
      blob: new ArrayBuffer(4),
      ext: "wav",
      customFetch,
    });

    const body = customFetch.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get("model_id")).toBe("scribe_v2");
  });
});

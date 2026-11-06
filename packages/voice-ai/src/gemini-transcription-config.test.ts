import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_MAX_CUSTOM_VOCABULARY_TERMS,
  GEMINI_MAX_CUSTOM_VOCABULARY_TERM_LENGTH,
  geminiTranscribeAudio,
} from "./gemini.utils";

afterEach(() => vi.restoreAllMocks());

describe("Gemini dedicated transcription configuration", () => {
  it.each([
    {
      diarization: false,
      timestamps: false,
      expected: { mode: "SMART", customVocabulary: ["term"] },
    },
    {
      diarization: true,
      timestamps: false,
      expected: { mode: "VERBATIM", diarization: true },
    },
    {
      diarization: false,
      timestamps: true,
      expected: { mode: "VERBATIM", wordTimestamp: true },
    },
    {
      diarization: true,
      timestamps: true,
      expected: { mode: "VERBATIM", diarization: true, wordTimestamp: true },
    },
  ])(
    "sends compatible vocabulary and mode for diarization=$diarization timestamps=$timestamps",
    async ({ diarization, timestamps, expected }) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const customFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("upload unavailable", { status: 400 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "ok" }] } }],
            }),
            { status: 200 },
          ),
        );
      await geminiTranscribeAudio({
        apiKey: "key",
        model: "gemini-3.5-transcribe",
        blob: new ArrayBuffer(1),
        language: "auto",
        transcriptionMode: "smart",
        customVocabulary: [" term ", "   "],
        enableDiarization: diarization,
        enableWordTimestamps: timestamps,
        customFetch,
      });
      const [, request] = customFetch.mock.calls[1];
      const body = JSON.parse(request.body as string);
      expect(body.generationConfig.audioTranscriptionConfig).toEqual(expected);
    },
  );

  it("normalizes language and caps nonempty vocabulary without changing verbatim mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const customFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("upload unavailable", { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
          }),
          { status: 200 },
        ),
      );
    const longTerm = "x".repeat(GEMINI_MAX_CUSTOM_VOCABULARY_TERM_LENGTH + 5);
    await geminiTranscribeAudio({
      apiKey: "key",
      model: "gemini-3.5-transcribe",
      blob: new ArrayBuffer(1),
      language: "fr",
      transcriptionMode: "verbatim",
      customVocabulary: [
        "  ",
        ` ${longTerm} `,
        ...Array.from(
          { length: GEMINI_MAX_CUSTOM_VOCABULARY_TERMS },
          (_, i) => `term-${i}`,
        ),
      ],
      customFetch,
    });
    const [, request] = customFetch.mock.calls[1];
    const config = JSON.parse(request.body as string).generationConfig
      .audioTranscriptionConfig;
    expect(config.languageCodes).toEqual(["fr-FR"]);
    expect(config.mode).toBe("VERBATIM");
    expect(config.customVocabulary).toHaveLength(
      GEMINI_MAX_CUSTOM_VOCABULARY_TERMS,
    );
    expect(config.customVocabulary[0]).toBe(
      longTerm.slice(0, GEMINI_MAX_CUSTOM_VOCABULARY_TERM_LENGTH),
    );
    expect(config.customVocabulary.at(-1)).toBe(
      `term-${GEMINI_MAX_CUSTOM_VOCABULARY_TERMS - 2}`,
    );
  });
});

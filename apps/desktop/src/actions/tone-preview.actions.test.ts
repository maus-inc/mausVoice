import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import {
  getPostProcessMaxTokens,
  PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
} from "../utils/prompt.utils";

const { generate } = vi.hoisted(() => ({
  generate: vi.fn(async (_input: unknown) => ({ text: "" })),
}));
vi.mock("../repos", () => ({
  getGenerateTextRepo: () => ({ repo: { generateText: generate } }),
}));
vi.mock("../utils/user.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/user.utils")>()),
  getMyUserName: () => "Tester",
  loadMyEffectiveDictationLanguage: async () => "en",
}));
import { previewToneStyle } from "./tone-preview.actions";

beforeEach(() => {
  generate.mockReset();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("style preview provider contract", () => {
  it.each([
    ["a".repeat(8000) + "OVERFLOW", "a".repeat(8000)],
    ["a".repeat(7999) + "😀OVERFLOW", "a".repeat(7999)],
    ["a".repeat(7998) + "😀OVERFLOW", "a".repeat(7998) + "😀"],
  ])(
    "bounds provider input without splitting a surrogate pair (%#)",
    async (sample, bounded) => {
      generate.mockResolvedValueOnce({ text: "styled" });
      await previewToneStyle(
        { promptTemplate: "Be concise." },
        sample,
        new AbortController().signal,
      );
      const { prompt } = generate.mock.calls[0][0] as { prompt: string };
      expect(prompt).toContain(bounded);
      expect(prompt).not.toContain("OVERFLOW");
      expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    },
  );
  it.each([
    ['{"result":"Styled sample"}', "Styled sample"],
    ['```json\n{"result":"Styled sample"}\n```', "Styled sample"],
    ['`{"result":"Styled sample"}`', "Styled sample"],
    ['{"result":""}', ""],
    ["  Plain provider output  ", "Plain provider output"],
  ])("parses provider output %s", async (text, expected) => {
    generate.mockResolvedValueOnce({ text });
    expect(
      await previewToneStyle(
        { promptTemplate: "Be concise." },
        "sample",
        new AbortController().signal,
      ),
    ).toBe(expected);
  });

  it("requests the same response schema as production and forwards cancellation", async () => {
    generate.mockResolvedValueOnce({ text: '{"result":"Styled"}' });
    const controller = new AbortController();
    await previewToneStyle(
      { promptTemplate: "Be concise." },
      "sample",
      controller.signal,
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        maxTokens: getPostProcessMaxTokens("sample"),
        reasoningEffort: "low",
        jsonResponse: {
          name: "transcription_cleaning",
          description: "JSON response with the processed transcription",
          schema: PROCESSED_TRANSCRIPTION_JSON_SCHEMA,
        },
      }),
    );
  });
});

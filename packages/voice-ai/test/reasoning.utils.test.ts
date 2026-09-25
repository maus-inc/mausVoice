import { describe, expect, it } from "vitest";
import {
  buildGeminiThinkingConfig,
  buildGptOssReasoningParams,
  isGptOssReasoningModel,
} from "../src/reasoning.utils";

describe("isGptOssReasoningModel", () => {
  it.each([
    "gpt-oss-120b",
    "gpt-oss-20b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-safeguard-20b",
  ])("recognizes %s", (model) => {
    expect(isGptOssReasoningModel(model)).toBe(true);
  });

  it.each(["gpt-oss", "gemma-4-31b", "qwen/qwen3.6-27b", "kimi-k2.7-code"])(
    "does not match %s",
    (model) => {
      expect(isGptOssReasoningModel(model)).toBe(false);
    },
  );
});

describe("buildGptOssReasoningParams", () => {
  it("asks GPT-OSS models for low-effort reasoning with the channel hidden", () => {
    expect(buildGptOssReasoningParams("openai/gpt-oss-20b")).toEqual({
      reasoning_effort: "low",
      reasoning_format: "hidden",
    });
  });

  // Both providers reject the reasoning fields on models without a GPT-OSS
  // reasoning channel, so the request body must stay free of the keys.
  it("adds nothing for models without a GPT-OSS reasoning channel", () => {
    expect(buildGptOssReasoningParams("gemma-4-31b")).toEqual({});
    expect(buildGptOssReasoningParams("qwen/qwen3.6-27b")).toEqual({});
  });
});

describe("buildGeminiThinkingConfig", () => {
  it("drops Gemini 3 Flash and Pro models to the low thinking level", () => {
    expect(buildGeminiThinkingConfig("gemini-3.7-flash")).toEqual({
      thinkingLevel: "low",
    });
    expect(buildGeminiThinkingConfig("gemini-3.1-pro-preview")).toEqual({
      thinkingLevel: "low",
    });
  });

  it("accepts resource-name model ids", () => {
    expect(buildGeminiThinkingConfig("models/gemini-3.7-flash")).toEqual({
      thinkingLevel: "low",
    });
  });

  it("turns thinking off for Gemini 2.5 Flash models", () => {
    expect(buildGeminiThinkingConfig("gemini-2.5-flash")).toEqual({
      thinkingBudget: 0,
    });
    expect(buildGeminiThinkingConfig("gemini-2.5-flash-lite")).toEqual({
      thinkingBudget: 0,
    });
  });

  it("leaves models at their own default when the lowest level is unknown", () => {
    // Flash-Lite already defaults to minimal thinking, image variants reject
    // the level, and older families have no thinking parameter at all.
    expect(buildGeminiThinkingConfig("gemini-3.5-flash-lite")).toBeNull();
    expect(buildGeminiThinkingConfig("gemini-3.1-flash-lite-image")).toBeNull();
    expect(buildGeminiThinkingConfig("gemini-1.5-flash")).toBeNull();
  });
});

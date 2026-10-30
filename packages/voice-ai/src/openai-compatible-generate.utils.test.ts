import { describe, expect, it } from "vitest";
import { buildReasoningEffortParams } from "./openai-compatible-generate.utils";

describe("buildReasoningEffortParams", () => {
  it.each(["openai/gpt-oss-20b", "openai/gpt-oss-120b", "gpt-oss-120b"])(
    "sets the effort for gpt-oss model %s",
    (model) => {
      expect(buildReasoningEffortParams(model, "low")).toEqual({
        reasoning_effort: "low",
      });
    },
  );

  it.each(["qwen/qwen3.8-27b", "gemma-4-31b", "gpt-4o-mini", "my-gpt-oss-x"])(
    "sends no effort field for %s, which rejects low/medium/high",
    (model) => {
      expect(buildReasoningEffortParams(model, "low")).toEqual({});
    },
  );

  it("sends nothing when the caller does not ask for an effort", () => {
    expect(buildReasoningEffortParams("openai/gpt-oss-20b", undefined)).toEqual(
      {},
    );
  });
});

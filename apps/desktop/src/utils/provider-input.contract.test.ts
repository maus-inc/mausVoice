import { LlmProviderInputZod, SttProviderInputZod } from "@maus-inc/types";
import { describe, expect, it } from "vitest";

describe.each([
  ["language model", LlmProviderInputZod],
  ["speech", SttProviderInputZod],
] as const)("%s provider input", (_name, schema) => {
  const valid = {
    provider: "example",
    name: "My provider",
    url: "https://example.test",
    model: "model",
    tier: 1,
  };

  it("defaults a missing key while preserving a supplied key and id", () => {
    expect(schema.parse(valid)).toEqual({ ...valid, apiKey: "" });
    expect(schema.parse({ ...valid, apiKey: "secret", id: "id" })).toEqual({
      ...valid,
      apiKey: "secret",
      id: "id",
    });
  });

  it("rejects unknown properties and non-integer tiers", () => {
    expect(schema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(schema.safeParse({ ...valid, tier: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, model: null }).success).toBe(false);
  });
});

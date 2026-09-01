import { describe, expect, it } from "vitest";
import {
  appendOpenAICompatiblePath,
  buildOpenAICompatibleUrl,
} from "./openai-compatible.utils";

describe("OpenAI-compatible URL construction", () => {
  it("adds v1 by default without duplicating it", () => {
    expect(buildOpenAICompatibleUrl("https://example.com/api")).toBe(
      "https://example.com/api/v1",
    );
    expect(buildOpenAICompatibleUrl("https://example.com/api/v1/")).toBe(
      "https://example.com/api/v1",
    );
  });

  it("honors endpoints that do not expose a v1 prefix", () => {
    expect(buildOpenAICompatibleUrl("https://example.com/openai", false)).toBe(
      "https://example.com/openai",
    );
  });

  it("preserves reverse-proxy path prefixes when adding resource paths", () => {
    expect(
      appendOpenAICompatiblePath(
        "https://example.com/proxy/openai/v1",
        "models",
      ),
    ).toBe("https://example.com/proxy/openai/v1/models");
  });
});

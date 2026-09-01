import { describe, expect, it } from "vitest";
import {
<<<<<<< HEAD
  buildOpenAICompatibleTranscriptionUrl,
  buildOpenAICompatibleUrl,
  OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH,
} from "./openai-compatible.utils";

describe("buildOpenAICompatibleUrl", () => {
  it("appends /v1 by default", () => {
    expect(buildOpenAICompatibleUrl("http://localhost:8080")).toBe(
      "http://localhost:8080/v1",
    );
  });

  it("does not append /v1 when includeV1Path is false", () => {
    expect(buildOpenAICompatibleUrl("http://localhost:8080", false)).toBe(
      "http://localhost:8080",
    );
  });

  it("preserves an existing /v1 suffix", () => {
    expect(buildOpenAICompatibleUrl("http://localhost:8080/v1", true)).toBe(
      "http://localhost:8080/v1",
    );
    expect(buildOpenAICompatibleUrl("http://localhost:8080/v1", false)).toBe(
      "http://localhost:8080/v1",
    );
  });
});

describe("buildOpenAICompatibleTranscriptionUrl", () => {
  it("defaults to /audio/transcriptions under the v1 base URL", () => {
    expect(buildOpenAICompatibleTranscriptionUrl("http://localhost:8080")).toBe(
      "http://localhost:8080/v1/audio/transcriptions",
    );
  });

  it("returns the default path constant when no override is given", () => {
    const url = buildOpenAICompatibleTranscriptionUrl(
      "http://localhost:8080",
      true,
    );
    expect(url.endsWith(OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH)).toBe(
      true,
    );
  });

  it("supports an Open WebUI style override (custom path with includeV1Path=false)", () => {
    expect(
      buildOpenAICompatibleTranscriptionUrl(
        "http://localhost:8080",
        false,
        "/v1/audio/transcriptions",
      ),
    ).toBe("http://localhost:8080/v1/audio/transcriptions");
  });

  it("honors a custom override path that does not start with /", () => {
    expect(
      buildOpenAICompatibleTranscriptionUrl(
        "http://localhost:8080",
        true,
        "custom/path",
      ),
    ).toBe("http://localhost:8080/v1/custom/path");
=======
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
>>>>>>> origin/fix/superfix-review-findings
  });
});

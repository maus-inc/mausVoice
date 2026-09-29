import { describe, expect, it } from "vitest";
import * as providerErrorUtils from "./provider-error.utils";

describe("provider-error.utils", () => {
  it("exports only the readers and the scrubber, and no retry policy", () => {
    // Which statuses are worth not retrying is per provider, not a property of
    // HTTP. A shared set here becomes the policy every provider adopts by
    // default, and each one then has to argue with it: this module shipped a
    // terminal-status helper that returned true for 404 while the one provider
    // reading these helpers documented at length why 404 must never be terminal
    // for it. A module that cannot express the distinction should not offer to
    // make it.
    expect(Object.keys(providerErrorUtils).sort()).toEqual([
      "PROVIDER_MODEL_NOT_FOUND_CODE",
      "readProviderCode",
      "readProviderStatus",
      "redactProviderMessage",
    ]);
  });
});

describe("readProviderStatus", () => {
  it("reads a status set directly on the error", () => {
    expect(providerErrorUtils.readProviderStatus({ status: 503 })).toBe(503);
  });

  it("returns undefined when there is no numeric status", () => {
    expect(providerErrorUtils.readProviderStatus(new Error("boom"))).toBe(
      undefined,
    );
    expect(providerErrorUtils.readProviderStatus({ status: "503" })).toBe(
      undefined,
    );
    expect(providerErrorUtils.readProviderStatus(null)).toBe(undefined);
    expect(providerErrorUtils.readProviderStatus("503")).toBe(undefined);
  });
});

describe("readProviderCode", () => {
  it("reads a code set on the error", () => {
    expect(providerErrorUtils.readProviderCode({ code: "rate_limit" })).toBe(
      "rate_limit",
    );
  });

  it("reads a code from the parsed error body", () => {
    expect(
      providerErrorUtils.readProviderCode({
        error: { code: providerErrorUtils.PROVIDER_MODEL_NOT_FOUND_CODE },
      }),
    ).toBe("model_not_found");
  });

  it("prefers the outer code and ignores a non-string one", () => {
    expect(
      providerErrorUtils.readProviderCode({
        code: "outer",
        error: { code: 7 },
      }),
    ).toBe("outer");
    expect(providerErrorUtils.readProviderCode({ code: 7 })).toBe(undefined);
  });
});

describe("redactProviderMessage", () => {
  // The key-shaped strings are split at the prefix so the secret scanner never
  // sees a contiguous token. It reads a full one as a leak, which is the right
  // call for real commits and the wrong one for a fixture, so the convention
  // here is the one the rest of this package's tests already use.
  const GROQ_KEY = "gsk_" + "liveAbCd1234";
  const CEREBRAS_KEY = "csk_" + "abc123DEF";

  it.each([
    ["a groq key", `Incorrect API key provided: ${GROQ_KEY}`, "gsk_"],
    [
      "a groq key with a hyphen",
      `Incorrect API key provided: ${GROQ_KEY.replace("_", "-")}`,
      "gsk-",
    ],
    ["a cerebras key", `rejected ${CEREBRAS_KEY}`, "csk_"],
    ["an openai style key", "rejected sk-proj-abc123", "sk-"],
    ["a bearer header", "Authorization: Bearer abc.def-ghi_jkl", "Bearer"],
    ["an authorization header", "authorization: token123abc", "authorization"],
    ["an api key assignment", "api_key=abc123def", "api_key"],
  ])("scrubs %s", (_label, input, mustNotSurvive) => {
    const output = providerErrorUtils.redactProviderMessage(input);
    expect(output).not.toContain(mustNotSurvive);
    expect(output).toContain("[redacted]");
  });

  it("leaves an ordinary message alone", () => {
    const message =
      "The model llama-3 does not exist or you do not have access";
    expect(providerErrorUtils.redactProviderMessage(message)).toBe(message);
  });
});

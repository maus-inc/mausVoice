import { describe, expect, it } from "vitest";
import { redactProviderMessage } from "./provider-error.utils";

/**
 * The scrubber's contract, stated once so a new pattern is measured against it
 * rather than against whatever happened to be in the tree. A provider error is
 * shown in a snackbar, written to the log, and attached to a diagnostics zip, so
 * anything that reaches a caller's screen has to already be free of their key.
 */
describe("redactProviderMessage", () => {
  describe("a key field with or without a recognised value prefix", () => {
    // The three prefixes the module documents, plus one that it does not know.
    // The unprefixed value is the case that matters: the prefix patterns above
    // cannot catch it, so the label pattern is the only thing standing between
    // it and the log.
    const prefixes = [
      ["gsk", "gsk_abc123XYZ"],
      ["csk", "csk_abc123XYZ"],
      ["sk", "sk-abc123XYZ"],
      ["sk underscore", "sk_abc123XYZ"],
      ["no known prefix", "abc123XYZnotaprefix"],
    ] as const;

    it.each(prefixes)("redacts %s in a JSON body", (_label, value) => {
      const body = `{"api_key":"${value}"}`;
      const cleaned = redactProviderMessage(body);

      expect(cleaned).not.toContain(value);
      expect(cleaned).toContain("[redacted]");
    });

    it.each(prefixes)("redacts %s in an unquoted field", (_label, value) => {
      for (const body of [
        `api_key=${value}`,
        `api_key: ${value}`,
        `API-KEY = ${value}`,
      ]) {
        const cleaned = redactProviderMessage(body);
        expect(cleaned, body).not.toContain(value);
        expect(cleaned, body).toContain("[redacted]");
      }
    });
  });

  it("still redacts a bearer token and an authorization header", () => {
    expect(
      redactProviderMessage("Authorization: Bearer abc.def-ghi"),
    ).not.toContain("abc.def-ghi");
    expect(redactProviderMessage("authorization: abc123XYZ")).not.toContain(
      "abc123XYZ",
    );
  });

  it("leaves an ordinary hyphenated token alone", () => {
    // The documented intent of the leading \b: `sk-` must not match inside a
    // longer word, or every hyphenated identifier in a log line would be
    // redacted and the message would be useless.
    for (const message of [
      "task-12345",
      "the sprint-period review",
      "monkey-12345",
      "disk-usage 88%",
    ]) {
      expect(redactProviderMessage(message)).toBe(message);
    }
  });

  it("leaves a sentence that merely names a key alone", () => {
    const message = "the api key you pasted was rejected";
    expect(redactProviderMessage(message)).toBe(message);
  });
});

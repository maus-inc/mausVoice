import { describe, expect, it } from "vitest";
import { unknownToMessage } from "./error";

describe("unknownToMessage", () => {
  it("returns Error.message", () => {
    expect(unknownToMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a plain string as-is", () => {
    expect(unknownToMessage("plain")).toBe("plain");
  });

  it("JSON-stringifies plain objects instead of [object Object]", () => {
    expect(unknownToMessage({ code: "E_BOOM" })).toBe('{"code":"E_BOOM"}');
  });

  it("redacts bearer tokens and provider key prefixes", () => {
    expect(unknownToMessage("401 Bearer abcdefghijklmnop status")).toBe(
      "401 Bearer [redacted] status",
    );
    expect(unknownToMessage("csk_live_abcdefghijk")).toBe("[redacted]");
    expect(unknownToMessage("gsk_abcdefghijklmnop")).toBe("[redacted]");
  });

  it("redacts labeled api keys in both assignment and JSON forms", () => {
    expect(unknownToMessage("api_key=supersecretvalue")).toBe(
      "api_key=[redacted]",
    );
    expect(unknownToMessage('api_key = "secret value"')).toBe(
      "api_key=[redacted]",
    );
    expect(unknownToMessage('api_key: "secret value"')).toBe(
      "api_key:[redacted]",
    );
    expect(unknownToMessage('api_key="secret \\"inner\\" value"')).toBe(
      "api_key=[redacted]",
    );
    expect(unknownToMessage({ apiKey: "supersecretvalue" })).toBe(
      '{"apiKey":"[redacted]"}',
    );
    expect(unknownToMessage({ apiKey: "secret value" })).toBe(
      '{"apiKey":"[redacted]"}',
    );
    expect(
      unknownToMessage({ nested: { authorization: "secret, value" } }),
    ).toBe('{"nested":{"authorization":"[redacted]"}}');
    let deep: unknown = { apiKey: "supersecretvalue" };
    for (let i = 0; i < 8; i += 1) deep = { nested: deep };
    expect(unknownToMessage(deep)).not.toContain("supersecretvalue");
    expect(unknownToMessage('{"apiKey":"secret value","code":"E_BOOM"}')).toBe(
      '{"apiKey":"[redacted]","code":"E_BOOM"}',
    );
  });

  it("caps huge payloads", () => {
    const message = unknownToMessage("x".repeat(600));
    expect(message).toHaveLength(513);
    expect(message.endsWith("…")).toBe(true);
    expect(message.startsWith("x".repeat(512))).toBe(true);
  });
});

describe("unknownToMessage labeled-secret edge cases", () => {
  it("redacts JSON-style quoted property names embedded in free text", () => {
    expect(
      unknownToMessage('upstream said {"apiKey":"secret value"} and gave up'),
    ).toBe("upstream said {apiKey:[redacted]} and gave up");
    expect(unknownToMessage('header "authorization"=abc123def')).toBe(
      "header authorization=[redacted]",
    );
  });

  it("keeps placeholder values that describe the field instead of a credential", () => {
    expect(unknownToMessage("api_key=required")).toBe("api_key=required");
    expect(unknownToMessage("authorization: missing")).toBe(
      "authorization: missing",
    );
    expect(unknownToMessage("access_token=null")).toBe("access_token=null");
  });

  it("does not treat a longer identifier as a secret label", () => {
    expect(unknownToMessage("api_key_length=32")).toBe("api_key_length=32");
  });
});

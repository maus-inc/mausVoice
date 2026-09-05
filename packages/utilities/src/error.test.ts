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
    expect(unknownToMessage({ apiKey: "supersecretvalue" })).toBe(
      '{"apiKey":"[redacted]"}',
    );
    expect(unknownToMessage({ apiKey: "secret value" })).toBe(
      '{"apiKey":"[redacted]"}',
    );
    expect(
      unknownToMessage({ nested: { authorization: "secret, value" } }),
    ).toBe('{"nested":{"authorization":"[redacted]"}}');
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

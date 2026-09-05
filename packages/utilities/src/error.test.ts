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
});

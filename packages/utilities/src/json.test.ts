import { describe, expect, it } from "vitest";
import { parseJsonObject } from "./json";

describe("parseJsonObject", () => {
  it.each(["null", "[]", "42", '"text"', "true", "invalid JSON", ""])(
    "rejects non-object input %s",
    (input) => expect(parseJsonObject(input)).toBeNull(),
  );

  it("preserves an empty object and nested JSON values", () => {
    expect(parseJsonObject("{}")).toEqual({});
    const value = {
      reason: "test",
      text: "hello",
      nested: { list: [null, 1] },
    };
    expect(parseJsonObject(JSON.stringify(value))).toEqual(value);
  });
});

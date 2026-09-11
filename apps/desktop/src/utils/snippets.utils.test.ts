import { describe, expect, it } from "vitest";
import {
  decodeMultiselectValue,
  encodeMultiselectValue,
} from "./snippets.utils";

describe("snippets.utils", () => {
  describe("multiselect round-trip", () => {
    it("preserves values containing commas", () => {
      const values = ["red, blue", "plain", "a,b,c"];
      expect(decodeMultiselectValue(encodeMultiselectValue(values))).toEqual(
        values,
      );
    });

    it("round-trips an empty selection", () => {
      expect(decodeMultiselectValue(encodeMultiselectValue([]))).toEqual([]);
      expect(decodeMultiselectValue("")).toEqual([]);
    });

    it("rejects payloads that are not string arrays", () => {
      expect(() => decodeMultiselectValue('{"a":1}')).toThrow();
      expect(() => decodeMultiselectValue('["ok",42]')).toThrow();
      expect(() => decodeMultiselectValue("not json")).toThrow();
    });
  });
});

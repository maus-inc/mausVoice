import { describe, expect, it } from "vitest";
import { restoreDictionaryOrder } from "./restore-dictionary-order";

describe("restoreDictionaryOrder", () => {
  const previous = ["a", "b", "c", "d"];

  it("restores before the nearest surviving following neighbor", () => {
    const ids = ["new", "a", "d"];
    restoreDictionaryOrder(ids, previous, "b");
    expect(ids).toEqual(["new", "a", "b", "d"]);
  });

  it("uses the nearest previous neighbor if following ones were removed", () => {
    const ids = ["new", "a", "other"];
    restoreDictionaryOrder(ids, previous, "b");
    expect(ids).toEqual(["new", "a", "b", "other"]);
  });

  it("falls back to the old index when no neighbors remain", () => {
    const ids = ["new", "other"];
    restoreDictionaryOrder(ids, previous, "c");
    expect(ids).toEqual(["new", "other", "c"]);
  });

  it("does not duplicate an ID already restored by another update", () => {
    const ids = ["a", "b", "new"];
    restoreDictionaryOrder(ids, previous, "b");
    expect(ids).toEqual(["a", "b", "new"]);
  });
});

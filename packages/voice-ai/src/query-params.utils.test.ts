import { describe, expect, it } from "vitest";
import { appendQueryParamValues } from "./query-params.utils";

describe("appendQueryParamValues", () => {
  it("appends one occurrence per value in order", () => {
    const params = new URLSearchParams();
    appendQueryParamValues(params, "keyterm", ["Soniya", "Ralf"]);
    expect(params.getAll("keyterm")).toEqual(["Soniya", "Ralf"]);
  });

  it("trims values and skips blank entries", () => {
    const params = new URLSearchParams();
    appendQueryParamValues(params, "keyterm", [" Kanye West ", "  ", "Nasa"]);
    expect(params.getAll("keyterm")).toEqual(["Kanye West", "Nasa"]);
  });

  it("keeps an empty list a no-op", () => {
    const params = new URLSearchParams({ model: "nova-3" });
    appendQueryParamValues(params, "keyterm", []);
    expect(params.has("keyterm")).toBe(false);
  });
});

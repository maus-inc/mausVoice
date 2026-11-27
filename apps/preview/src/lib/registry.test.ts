import { describe, expect, it } from "vitest";
import { DEMOS } from "../demos/index";
import { REGISTRY } from "./registry";

/**
 * The registry is a hand-maintained table and the demo map is another one, so
 * the two can drift: an entry whose `demo` key has no component renders a blank
 * page and no test notices. Every entry gets its demo, and the demo map gets no
 * orphan.
 */
describe("preview registry", () => {
  it("resolves a demo component for every entry", () => {
    const missing = REGISTRY.filter(
      (entry) => DEMOS[entry.demo] === undefined,
    ).map((entry) => `${entry.id} → ${entry.demo}`);
    expect(missing).toEqual([]);
  });

  it("keeps every demo reachable from an entry", () => {
    const used = new Set(REGISTRY.map((entry) => entry.demo));
    expect(Object.keys(DEMOS).filter((key) => !used.has(key))).toEqual([]);
  });

  it("gives every entry a unique id and a spec", () => {
    expect(new Set(REGISTRY.map((entry) => entry.id)).size).toBe(
      REGISTRY.length,
    );
    expect(
      REGISTRY.filter((entry) => entry.spec.length === 0).map((e) => e.id),
    ).toEqual([]);
  });
});

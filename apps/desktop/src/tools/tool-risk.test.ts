import { describe, expect, it } from "vitest";

import type { ToolInfo, ToolRisk } from "@maus-inc/types";
import { TOOL_RISK } from "@maus-inc/types";

import {
  createTool,
  getToolRegistryEntry,
  listRegisteredToolInfos,
  TOOL_REGISTRY,
} from "./index";

/**
 * A copy of a registered tool's own info with a tier that is not a tier.
 *
 * `createTool` resolves the registry entry from `info.id` first and only then
 * checks the tier, so the id has to be a real one for the guard to be reached.
 * This is the shape an older build's persisted info would have, and the shape a
 * future contributor gets by copying a neighbour's entry and mistyping a tier.
 */
const unratedInfo = (risk: string): ToolInfo => {
  const real = getToolRegistryEntry("paste")?.getInfo();
  if (!real) {
    throw new Error("paste is expected to be registered");
  }
  return { ...real, risk: risk as ToolRisk };
};

describe("tool risk tiers", () => {
  it("gives every registered tool a tier the permission map knows", () => {
    const tiers = Object.keys(TOOL_RISK);
    for (const info of listRegisteredToolInfos()) {
      expect(tiers, info.id).toContain(info.risk);
    }
  });

  it("refuses to build a tool whose tier is not one of the four", () => {
    expect(() => createTool(unratedInfo("medium-ish"))).toThrow(
      /has no valid risk tier/,
    );
  });

  it("names the tool and the allowed tiers in the refusal, so the error is actionable", () => {
    let message = "";
    try {
      createTool(unratedInfo("nonsense"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("paste");
    for (const tier of Object.keys(TOOL_RISK)) {
      expect(message, tier).toContain(tier);
    }
  });

  it("refuses an empty tier rather than reading it as the safest one", () => {
    // The dangerous direction is the silent one: an empty string is not in
    // `TOOL_RISK`, so it must not fall through to `low`.
    expect(() => createTool(unratedInfo(""))).toThrow(/has no valid risk tier/);
  });

  it("carries the same guard on the listing door", () => {
    // `listRegisteredToolInfos` is the other way into the map, used by the
    // settings dialog and by tool filtering. A guard on `createTool` alone
    // would leave that path registering an unrated tool.
    const entry = getToolRegistryEntry("paste");
    if (!entry) {
      throw new Error("paste is expected to be registered");
    }
    const original = entry.getInfo;
    const unrated = { ...unratedInfo("nonsense") };
    const mutable = TOOL_REGISTRY as unknown as Map<string, typeof entry>;
    mutable.set("paste", {
      ...entry,
      getInfo: () => unrated,
    });
    try {
      expect(() => listRegisteredToolInfos()).toThrow(/has no valid risk tier/);
    } finally {
      mutable.set("paste", { ...entry, getInfo: original });
    }
  });

  it("still lists tools once the entry is restored", () => {
    const ids = listRegisteredToolInfos().map((info) => info.id);
    expect(ids).toContain("paste");
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { ToolInfo } from "@maus-inc/types";

import { produceAppState } from "../store";
import { registerToolInfos } from "../utils/app.utils";
import { getToolAlwaysAllow } from "../utils/tool-permission.utils";

import { setToolAlwaysAllow } from "./tool.actions";

/**
 * The layer the permission card actually calls.
 *
 * `ToolPermissionCard` grants through `tool.actions.setToolAlwaysAllow`, which
 * used to build a `BaseTool` first. Computer-use permissions carry a synthetic
 * `ToolInfo` that has no `BaseTool`, because each action runs in the
 * computer-use loop rather than through the tool registry, so that build threw
 * `No tool implementation for: computer_use:click`. The throw landed before the
 * card's next line resolved the permission, so pressing "Always allow" turned
 * every prompt into the timeout denial it was meant to prevent, and the earlier
 * tests were green because they exercised the storage helper directly instead
 * of this function.
 */

const COMPUTER_USE_ID = "computer_use:click";

const computerUseInfo: ToolInfo = {
  id: COMPUTER_USE_ID,
  description: "Click at 960, 540",
  instructions: "Click at 960, 540",
  schema: { type: "object", properties: {} },
  risk: "high",
};

beforeEach(() => {
  window.localStorage.clear();
  produceAppState((draft) => {
    draft.toolInfoById = {};
    registerToolInfos(draft, [computerUseInfo]);
  });
});

describe("always allow for an action the tool registry does not implement", () => {
  it("writes the grant instead of throwing", () => {
    expect(() =>
      setToolAlwaysAllow({
        toolId: COMPUTER_USE_ID,
        params: {},
        allowed: true,
        scope: "conversation:alpha",
      }),
    ).not.toThrow();
  });

  it("records the grant at both the conversation and the action scope", () => {
    setToolAlwaysAllow({
      toolId: COMPUTER_USE_ID,
      params: {},
      allowed: true,
      scope: "conversation:alpha",
    });

    expect(getToolAlwaysAllow(COMPUTER_USE_ID, "conversation:alpha")).toBe(
      true,
    );
    expect(getToolAlwaysAllow(COMPUTER_USE_ID, "conversation:beta")).toBe(true);
  });

  it("clears every scope on revoke", () => {
    setToolAlwaysAllow({
      toolId: COMPUTER_USE_ID,
      params: {},
      allowed: true,
      scope: "conversation:alpha",
    });
    setToolAlwaysAllow({
      toolId: COMPUTER_USE_ID,
      params: {},
      allowed: false,
      scope: "conversation:alpha",
    });

    expect(getToolAlwaysAllow(COMPUTER_USE_ID, "conversation:alpha")).toBe(
      false,
    );
    expect(getToolAlwaysAllow(COMPUTER_USE_ID, "conversation:beta")).toBe(
      false,
    );
  });

  it("ignores an unknown tool id rather than throwing", () => {
    expect(() =>
      setToolAlwaysAllow({
        toolId: "never_registered",
        params: {},
        allowed: true,
      }),
    ).not.toThrow();
  });
});

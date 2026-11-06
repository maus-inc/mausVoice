import type { ToolInfo } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAllow, setAllow } = vi.hoisted(() => ({
  getAllow: vi.fn(),
  setAllow: vi.fn(),
}));
vi.mock("../utils/tool-permission.utils", () => ({
  getToolAlwaysAllow: getAllow,
  setToolAlwaysAllow: setAllow,
}));

import { EndConversationTool } from "./end-conversation.tool";
import { GetAccessibilityInfoTool } from "./get-accessibility-info.tool";
import { PasteTool } from "./paste.tool";
import { RunTerminalCommandTool } from "./run-terminal-command.tool";

const info = (id: string): ToolInfo => ({
  id,
  description: "",
  instructions: "",
  schema: { type: "object", properties: {} },
});

beforeEach(() => vi.resetAllMocks());

describe("tool permission defaults", () => {
  it.each([
    ["paste", PasteTool],
    ["get_accessibility_info", GetAccessibilityInfoTool],
    ["run_terminal_command", RunTerminalCommandTool],
  ])("uses scoped persistent decisions for %s", (id, Tool) => {
    const tool = new Tool(info(id));
    getAllow.mockReturnValue(true);
    expect(tool.getAlwaysAllow({})).toBe(true);
    expect(getAllow).toHaveBeenCalledWith(id, "global");
    expect(tool.getAlwaysAllow({}, "conversation-1")).toBe(true);
    expect(getAllow).toHaveBeenCalledWith(id, "conversation-1");
    tool.setAlwaysAllow({}, false, "conversation-1");
    expect(setAllow).toHaveBeenCalledWith(id, false, "conversation-1");
    tool.setAlwaysAllow({}, true);
    expect(setAllow).toHaveBeenCalledWith(id, true, "global");
  });

  it("keeps end-conversation intrinsically allowed without persisting a grant", () => {
    const tool = new EndConversationTool(info("end_conversation"));
    expect(tool.getAlwaysAllow({}, "conversation-1")).toBe(true);
    tool.setAlwaysAllow({}, false, "conversation-1");
    expect(getAllow).not.toHaveBeenCalled();
    expect(setAllow).not.toHaveBeenCalled();
  });
});

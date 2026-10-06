import type { JSONSchema, ToolInfo, ToolRisk } from "@maus-inc/types";
import { TOOL_RISK } from "@maus-inc/types";
import { getAppState } from "../store";
import { getIsPowerModeEnabled } from "../utils/assistant-mode.utils";
import { getAllowedTerminalBinaries } from "../utils/platform.utils";
import type { BaseTool } from "./base.tool";
import { EndConversationTool } from "./end-conversation.tool";
import { GetAccessibilityInfoTool } from "./get-accessibility-info.tool";
import { PasteTool } from "./paste.tool";
import { RunTerminalCommandTool } from "./run-terminal-command.tool";

type ToolFactory = (info: ToolInfo) => BaseTool;
type ToolRegistryEntry = {
  id: string;
  scope?: ToolInfo["scope"];
  factory: ToolFactory;
  getInfo: () => ToolInfo | null;
};

const staticInfo = (
  id: string,
  description: string,
  instructions: string,
  schema: JSONSchema,
  risk: ToolRisk,
  scope?: ToolInfo["scope"],
): ToolInfo => ({ id, description, instructions, schema, risk, scope });

/**
 * Every registered tool states a risk tier, and an unrated tool is refused
 * rather than registered.
 *
 * The check sits in `createTool` rather than in the type alone because a
 * registry entry is data: a tool added without a tier still type-checks if
 * `risk` were optional, and an unrated tool that reached a permission prompt
 * would be treated as safe. `listRegisteredToolInfos` is the other door into
 * this map and carries the same guard, so neither path can register one.
 */
const assertRateable = (info: ToolInfo): ToolInfo => {
  if (!Object.hasOwn(TOOL_RISK, info.risk)) {
    throw new Error(
      `Tool ${info.id} has no valid risk tier. Every tool must declare one of: ` +
        `${Object.keys(TOOL_RISK).join(", ")}.`,
    );
  }
  return info;
};

/**
 * Declarative tool registry.  Adding a tool now means registering its factory
 * and metadata once; the agent and settings surfaces consume the same list.
 */
export const TOOL_REGISTRY: ReadonlyMap<string, ToolRegistryEntry> = new Map<
  string,
  ToolRegistryEntry
>([
  [
    "paste",
    {
      id: "paste",
      factory: (info) => new PasteTool(info),
      getInfo: () =>
        staticInfo(
          "paste",
          "Paste text",
          "Paste text into the currently focused text field on the user's screen. Always use this when the user is requesting to rewrite text that they have selected.",
          {
            type: "object",
            properties: {
              text: { type: "string", description: "The text to paste" },
            },
            required: ["text"],
          },
          // Writes into whatever has focus, so it can overwrite a field the
          // user was part-way through editing. It is recoverable, hence medium
          // rather than high.
          "medium",
        ),
    },
  ],
  [
    "get_accessibility_info",
    {
      id: "get_accessibility_info",
      factory: (info) => new GetAccessibilityInfoTool(info),
      getInfo: () =>
        staticInfo(
          "get_accessibility_info",
          "Read screen context",
          "Get accessibility information about the currently focused UI element, including text field content, cursor position, selection, and surrounding screen context. Use this to understand what the user is looking at before taking action.",
          { type: "object", properties: {} },
          // Reads the screen and never writes to it.
          "low",
        ),
    },
  ],
  [
    "end_conversation",
    {
      id: "end_conversation",
      scope: "pill",
      factory: (info) => new EndConversationTool(info),
      getInfo: () =>
        staticInfo(
          "end_conversation",
          "End conversation",
          "End the current conversation and close the assistant. ALWAYS call this after pasting text in.",
          { type: "object", properties: {} },
          "low",
          "pill",
        ),
    },
  ],
  [
    "run_terminal_command",
    {
      id: "run_terminal_command",
      factory: (info) => new RunTerminalCommandTool(info),
      getInfo: () => {
        if (!getIsPowerModeEnabled(getAppState())) return null;
        return staticInfo(
          "run_terminal_command",
          "Run a read-only terminal command",
          "Execute a restricted allow-listed terminal command without a shell (no sh/cmd/bash, pipes, redirection, or shell metacharacters) and return its output. Each command has a 15-second timeout and output is capped at 128 KiB. " +
            `Allowed binaries on this platform: ${getAllowedTerminalBinaries().join(", ")}. ` +
            "Use this for read-only inspection only.",
          {
            type: "object",
            properties: {
              command: {
                type: "string",
                description:
                  "A single allow-listed command with plain arguments.",
              },
            },
            required: ["command"],
          },
          // Arbitrary process execution, even allow-listed. There is no undo,
          // hence high rather than medium.
          "high",
        );
      },
    },
  ],
]);

export const listRegisteredToolInfos = (): ToolInfo[] =>
  [...TOOL_REGISTRY.values()]
    .map((entry) => entry.getInfo())
    .filter((info): info is ToolInfo => info !== null)
    .map(assertRateable);

export const getToolRegistryEntry = (
  toolId: string,
): ToolRegistryEntry | undefined => TOOL_REGISTRY.get(toolId);

export function createTool(info: ToolInfo): BaseTool {
  const entry = TOOL_REGISTRY.get(info.id);
  if (!entry) {
    throw new Error(`No tool implementation for: ${info.id}`);
  }
  return entry.factory(assertRateable(info));
}

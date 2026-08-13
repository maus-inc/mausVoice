import type { ToolInfo } from "@maus-inc/types";
import { getAppState } from "../store";
import { getIsPowerModeEnabled } from "../utils/assistant-mode.utils";
import { getAllowedTerminalBinaries } from "../utils/platform.utils";
import { BaseRepo } from "./base.repo";

export class ToolRepo extends BaseRepo {
  async listToolInfos(): Promise<ToolInfo[]> {
    const tools: ToolInfo[] = [
      {
        id: "paste",
        description: "Paste text",
        instructions:
          "Paste text into the currently focused text field on the user's screen. Always use this when the user is requesting to rewrite text that they have selected.",
        schema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text to paste" },
          },
          required: ["text"],
        },
      },
      {
        id: "get_accessibility_info",
        description: "Read screen context",
        instructions:
          "Get accessibility information about the currently focused UI element, including text field content, cursor position, selection, and surrounding screen context. Use this to understand what the user is looking at before taking action.",
        schema: {
          type: "object",
          properties: {},
        },
      },
      {
        id: "end_conversation",
        description: "End conversation",
        instructions:
          "End the current conversation and close the assistant. ALWAYS call this after pasting text in.",
        schema: {
          type: "object",
          properties: {},
        },
        scope: "pill",
      },
    ];

    if (getIsPowerModeEnabled(getAppState())) {
      tools.push({
        id: "run_terminal_command",
        description: "Run a read-only terminal command",
        instructions:
          "Execute a restricted allow-listed terminal command without a shell (no `sh`/`cmd`/`bash`, no pipes/redirection/shell metacharacters) and return its output. " +
          `Allowed binaries on this platform: ${getAllowedTerminalBinaries().join(", ")}. ` +
          "The command is whitespace-tokenised, times out after 15 seconds, and output is capped at 128KiB. " +
          "Use this for read-only inspection (listing directories, checking system state, reading small files). Do NOT attempt scripts, file edits, network commands, or chained commands — those will be rejected.",
        schema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description:
                "A single allow-listed command with plain arguments, e.g. 'ls -la ~/Documents'. No shell metacharacters.",
            },
          },
          required: ["command"],
        },
      });
    }

    return tools;
  }
}

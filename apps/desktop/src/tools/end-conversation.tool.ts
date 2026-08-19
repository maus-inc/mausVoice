import { emitTo } from "@tauri-apps/api/event";
import { BaseTool, type ToolResult } from "./base.tool";

export class EndConversationTool extends BaseTool {
  async execute(): Promise<ToolResult> {
    await emitTo("main", "assistant-mode-close", {});
    return {};
  }

  getAlwaysAllow(): boolean {
    return true;
  }

  setAlwaysAllow(_params: Record<string, unknown>, _allowed: boolean): void {
    // This tool is always allowed, so the setting is intentionally ignored.
    return;
  }
}

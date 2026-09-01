import { emitTo } from "@tauri-apps/api/event";
import { BaseTool, type ToolResult } from "./base.tool";

export class EndConversationTool extends BaseTool {
  async execute(): Promise<ToolResult> {
    await emitTo("main", "assistant-mode-close", {});
    return {};
  }

  getAlwaysAllow(_params: Record<string, unknown>, _scope?: string): boolean {
    return true;
  }

  setAlwaysAllow(
    _params: Record<string, unknown>,
    _allowed: boolean,
    _scope?: string,
  ): void {
    // End-conversation is inherently safe and never persists an allow-list decision.
    return undefined;
  }
}

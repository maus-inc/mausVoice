import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo } from "@maus-inc/types";
import { BaseTool, type ToolResult } from "./base.tool";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../utils/tool-permission.utils";

export class GetAccessibilityInfoTool extends BaseTool {
  constructor(info: ToolInfo) {
    super(info);
  }

  async execute(): Promise<ToolResult> {
    const [textFieldInfo, screenContext] = await Promise.all([
      invoke<{
        cursorPosition: number | null;
        selectionLength: number | null;
        textContent: string | null;
      }>("get_text_field_info"),
      invoke<{ screenContext: string | null }>("get_screen_context"),
    ]);

    return { ...textFieldInfo, ...screenContext };
  }

  getAlwaysAllow(_params: Record<string, unknown>, scope = "global"): boolean {
    return getToolAlwaysAllow(this.info.id, scope);
  }

  setAlwaysAllow(
    _params: Record<string, unknown>,
    allowed: boolean,
    scope = "global",
  ): void {
    setToolAlwaysAllow(this.info.id, allowed, scope);
  }
}

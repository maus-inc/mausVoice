import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo } from "@maus-inc/types";
import type {
  ScreenContextInfo,
  TextFieldInfo,
} from "../types/accessibility.types";
import { BaseTool, type ToolResult } from "./base.tool";

export class GetAccessibilityInfoTool extends BaseTool {
  constructor(info: ToolInfo) {
    super(info);
  }

  async execute(): Promise<ToolResult> {
    const [textFieldInfo, screenContext] = await Promise.all([
      invoke<TextFieldInfo>("get_text_field_info"),
      invoke<ScreenContextInfo>("get_screen_context"),
    ]);

    return { ...textFieldInfo, ...screenContext };
  }
}

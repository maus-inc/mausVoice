import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo } from "@maus-inc/types";
import { BaseTool } from "./base.tool";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../utils/tool-permission.utils";
import { getAppState } from "../store";
import { reviewTextInComposer } from "../utils/composer.utils";

export class PasteTool extends BaseTool {
  constructor(info: ToolInfo) {
    super(info);
  }

  async execute(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestedText = typeof params.text === "string" ? params.text : "";
    const text =
      getAppState().userPrefs?.reviewBeforeInsert === true
        ? await reviewTextInComposer(requestedText)
        : requestedText;
    if (!text?.trim()) {
      return { canceled: true };
    }
    await invoke("paste", { text, keybind: null });
    return {};
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

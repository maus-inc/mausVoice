import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo } from "@maus-inc/types";
import { BaseTool, type ToolExecutionContext } from "./base.tool";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../utils/tool-permission.utils";
import { getAppState } from "../store";
import { reviewTranscriptBeforeInsert } from "../actions/pill-review.actions";
import { createPendingPasteReview } from "../actions/pending-paste-review.actions";

export class PasteTool extends BaseTool {
  constructor(info: ToolInfo) {
    super(info);
  }

  async execute(
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const requestedText = typeof params.text === "string" ? params.text : "";
    const text =
      getAppState().userPrefs?.reviewBeforeInsert === true
        ? await reviewTranscriptBeforeInsert(requestedText, "assistant-tool")
        : requestedText;
    if (!text?.trim()) {
      return { canceled: true };
    }
    // Saved before the native insert, not after: opening Chats to read the
    // saved review moves focus to mausVoice, so the insert below still lands in
    // whatever the agent was pasting into, and the durable record is what lets
    // the user recover the text once focus has moved.
    await createPendingPasteReview(context?.conversationId ?? "", text);
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

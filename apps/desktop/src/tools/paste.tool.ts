import { invoke } from "@tauri-apps/api/core";
import type { PasteOutcome } from "@maus-inc/desktop-native-apis";
import type { ToolInfo } from "@maus-inc/types";
import { BaseTool, type ToolExecutionContext } from "./base.tool";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../utils/tool-permission.utils";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
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
    let outcome: PasteOutcome;
    try {
      outcome = await invoke<PasteOutcome>("paste", { text, keybind: null });
    } catch (error) {
      // The insert never reached the target, so this is exactly the case the
      // saved review exists for: the text is only recoverable by hand. The
      // save is best-effort, and the insert's own failure is what the caller
      // has to see, so a failed write is logged rather than reported.
      await savePendingPasteReview(context?.conversationId ?? "", text);
      throw error;
    }
    if (outcome === "copied_to_clipboard") {
      // The focused target could not take the text, so nothing landed and the
      // clipboard fallback has to be turned into a deliberate hand-off.
      await savePendingPasteReview(context?.conversationId ?? "", text);
    }
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

/**
 * Record the paste for a manual hand-off, without ever failing the caller.
 *
 * The card is bookkeeping about a paste the user may already be able to
 * complete another way: on the clipboard fallback the text is in the clipboard,
 * and on a failed insert the insert's own error is the failure worth surfacing.
 * A chat-message write that rejects must not swallow either, or the user ends
 * up with neither the paste nor its record and only a bookkeeping error.
 */
const savePendingPasteReview = async (
  conversationId: string,
  text: string,
): Promise<void> => {
  try {
    await createPendingPasteReview(conversationId, text);
  } catch (error) {
    getLogger().error(`Failed to save the pending Paste review: ${error}`);
  }
};

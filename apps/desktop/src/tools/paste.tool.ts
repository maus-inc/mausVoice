import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import type { ToolInfo } from "@maus-inc/types";
import { BaseTool, type ToolExecutionContext } from "./base.tool";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../utils/tool-permission.utils";
import { getAppState } from "../store";
import { reviewTranscriptBeforeInsert } from "../actions/pill-review.actions";
import { createPendingPasteReview } from "../actions/pending-paste-review.actions";
import { getLogger } from "../utils/log.utils";

export class PasteTool extends BaseTool {
  constructor(info: ToolInfo) {
    super(info);
  }

  async execute(
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const requestedText = typeof params.text === "string" ? params.text : "";
    // Agent execution supplies its conversation explicitly. The fallback
    // preserves the direct native-pill invocation path, which predates the
    // agent execution context.
    const conversationId =
      context?.conversationId ?? getAppState().pillConversationId;
    let openedConversationId: string | null = null;
    const review =
      getAppState().userPrefs?.reviewBeforeInsert === true
        ? await reviewTranscriptBeforeInsert(
            requestedText,
            async (editedText) => {
              if (!conversationId) {
                getLogger().warning(
                  "Cannot open an agent Paste review because it has no conversation",
                );
                return false;
              }

              try {
                await createPendingPasteReview(conversationId, editedText);
              } catch (error) {
                getLogger().error(
                  `Could not save the edited agent Paste review: ${error}`,
                );
                // Do not settle the native card: it is the only remaining copy
                // of the edit when durable storage failed.
                return false;
              }

              // Keep the conversation id that the native card represented.
              // The review settles before we leave the pill, so re-reading the
              // live state later could pick up an unrelated new session.
              openedConversationId = conversationId;
              return true;
            },
          )
        : { action: "insert" as const, text: requestedText };
    if (review.action === "open") {
      if (!openedConversationId) {
        // A native Open decision can only resolve after the callback above
        // returns true, but fail closed if a future review implementation
        // violates that contract rather than navigating the wrong chat.
        getLogger().error(
          "Agent Paste review opened without a persisted conversation id",
        );
        return { pendingReview: true, delivery: "manual-paste" };
      }

      // The decision is already durable. Route and surface only after the
      // review settles, then use the same close transition as the pill's
      // ordinary Open action so its session cannot stay active behind Chats.
      try {
        const { browserRouter } = await import("../router");
        browserRouter.navigate(
          `/dashboard/chats?id=${encodeURIComponent(openedConversationId)}`,
        );
      } catch (error) {
        getLogger().warning(
          `Could not navigate to the saved agent Paste review: ${error}`,
        );
      }
      try {
        const { surfaceMainWindow } = await import("../utils/window.utils");
        await surfaceMainWindow();
      } catch (error) {
        getLogger().warning(
          `Could not surface the saved agent Paste review: ${error}`,
        );
      }
      try {
        await emitTo("main", "assistant-mode-close", {});
      } catch (error) {
        getLogger().warning(
          `Could not close the assistant after opening the Paste review: ${error}`,
        );
      }
      return {
        pendingReview: true,
        delivery: "manual-paste",
      };
    }

    const text = review.action === "insert" ? review.text : null;
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

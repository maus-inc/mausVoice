import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { PasteOutcome } from "@maus-inc/desktop-native-apis";
import type { ChatMessage, ToolInfo } from "@maus-inc/types";
import { BaseTool, type ToolExecutionContext } from "./base.tool";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../utils/tool-permission.utils";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { createId } from "../utils/id.utils";
import { getIntl } from "../i18n/intl";
import { runToast, showToast } from "../actions/toast.actions";
import { reviewTranscriptBeforeInsert } from "../actions/pill-review.actions";
import {
  createPendingPasteReview,
  updatePendingPasteReviewDraft,
  updatePendingPasteReviewDraftById,
} from "../actions/pending-paste-review.actions";

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

export class PasteTool extends BaseTool {
  constructor(info: ToolInfo) {
    super(info);
  }

  async execute(
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const requestedText = typeof params.text === "string" ? params.text : "";
    let openedPendingPaste = false;
    let copiedReviewedText = false;
    let reviewExpired = false;
    let reviewFailed = false;
    let pendingReviewMessage: ChatMessage | null = null;
    let latestSaveText: string | null = null;
    let latestSaveGeneration = 0;
    const conversationId = context?.conversationId;
    const pendingReviewId = conversationId ? createId() : null;
    const saveLatestReviewDraft = async (
      conversationId: string,
      text: string,
    ): Promise<void> => {
      // Do not queue behind an earlier request: a timed-out native hand-off
      // can leave its write promise unresolved. Reuse one id so a retry can
      // recover an already-committed create rather than making a second card.
      const generation = ++latestSaveGeneration;
      latestSaveText = text;
      if (pendingReviewMessage) {
        const saved = await updatePendingPasteReviewDraft(
          pendingReviewMessage,
          text,
        );
        if (generation !== latestSaveGeneration) {
          let corrected = saved;
          let correctedText = text;
          while (
            generation !== latestSaveGeneration &&
            latestSaveText &&
            correctedText !== latestSaveText
          ) {
            correctedText = latestSaveText;
            corrected = await updatePendingPasteReviewDraft(
              corrected,
              correctedText,
            );
          }
          return;
        }
        pendingReviewMessage = saved;
        return;
      }

      try {
        const saved = await createPendingPasteReview(
          conversationId,
          text,
          pendingReviewId ?? undefined,
        );
        if (!pendingReviewMessage || generation === latestSaveGeneration) {
          pendingReviewMessage = saved;
        }
      } catch (error) {
        const saveError = String(error).toLowerCase();
        const isDuplicateMessageId =
          saveError.includes("unique constraint failed") &&
          saveError.includes("chat_messages.id");
        if (
          !isDuplicateMessageId ||
          generation !== latestSaveGeneration ||
          !pendingReviewId
        ) {
          throw error;
        }
        pendingReviewMessage = await updatePendingPasteReviewDraftById(
          conversationId,
          pendingReviewId,
          text,
        );
      }
    };
    const reviewOptions = {
      onCopy: () => {
        copiedReviewedText = true;
      },
      onExpire: () => {
        reviewExpired = true;
      },
      onFailure: () => {
        reviewFailed = true;
      },
      ...(conversationId
        ? {
            onOpen: async (reviewedText: string, signal?: AbortSignal) => {
              // Save first: once Chats takes focus the pill cannot safely insert
              // into the app that had focus when the tool began.
              if (signal?.aborted) return;
              await saveLatestReviewDraft(conversationId, reviewedText);
              if (signal?.aborted) return;
              openedPendingPaste = true;
              try {
                await emit("open-pill-conversation", {
                  conversationId,
                  pendingPasteReview: true,
                });
              } catch (error) {
                // The durable card is still available in Chats even if native
                // surfacing or navigation could not be requested.
                getLogger().warning(
                  `Could not open the Paste review in Chats: ${error}`,
                );
                runToast(
                  showToast({
                    message: getIntl().formatMessage({
                      defaultMessage:
                        "Your Paste review was saved. Open Chats to find it and finish the paste.",
                    }),
                    toastType: "info",
                    duration: 8000,
                  }),
                );
              }
            },
          }
        : {}),
    };
    const text =
      getAppState().userPrefs?.reviewBeforeInsert === true
        ? await reviewTranscriptBeforeInsert(
            requestedText,
            "assistant-tool",
            reviewOptions,
          )
        : requestedText;
    if (openedPendingPaste) {
      return { awaitingManualPaste: true };
    }
    if (copiedReviewedText) {
      return { copiedToClipboard: true };
    }
    if (reviewExpired) {
      return { reviewExpired: true };
    }
    if (reviewFailed) {
      return { reviewFailed: true };
    }
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
      // clipboard fallback has to be turned into a deliberate hand-off. Tell
      // the agent too: an empty result would look indistinguishable from a
      // successful paste even though the user still needs to paste manually.
      await savePendingPasteReview(context?.conversationId ?? "", text);
      return { copiedToClipboard: true };
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

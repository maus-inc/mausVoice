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
  cancelPendingPasteReview,
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

type PasteReviewState = {
  openedPendingPaste: boolean;
  copiedReviewedText: boolean;
  reviewExpired: boolean;
  reviewFailed: boolean;
  pendingReviewMessage: ChatMessage | null;
  latestSaveText: string | null;
  latestSaveGeneration: number;
  reviewResolved: boolean;
  activeOpenSaves: number;
};

const createPasteReviewState = (): PasteReviewState => ({
  openedPendingPaste: false,
  copiedReviewedText: false,
  reviewExpired: false,
  reviewFailed: false,
  pendingReviewMessage: null,
  latestSaveText: null,
  latestSaveGeneration: 0,
  reviewResolved: false,
  activeOpenSaves: 0,
});

const cancelUnusedPendingReview = async (
  state: PasteReviewState,
): Promise<void> => {
  if (
    !state.reviewResolved ||
    state.activeOpenSaves > 0 ||
    state.openedPendingPaste ||
    !state.pendingReviewMessage
  ) {
    return;
  }
  const unusedMessage = state.pendingReviewMessage;
  try {
    await cancelPendingPasteReview(unusedMessage, "");
    state.pendingReviewMessage = null;
  } catch (error) {
    getLogger().warning(
      `Could not close an unused Paste review after the user chose another action: ${error}`,
    );
    runToast(
      showToast({
        message: getIntl().formatMessage({
          defaultMessage:
            "An unused Paste review could not be closed. Check Chats and dismiss the leftover card.",
        }),
        toastType: "error",
        duration: 8000,
      }),
    );
  }
};

const saveLatestReviewDraft = async (
  state: PasteReviewState,
  conversationId: string,
  pendingReviewId: string | null,
  text: string,
): Promise<void> => {
  // Do not queue behind an earlier request: a timed-out native hand-off
  // can leave its write promise unresolved. Reuse one id so a retry can
  // recover an already-committed create rather than making a second card.
  const generation = ++state.latestSaveGeneration;
  state.latestSaveText = text;
  if (state.pendingReviewMessage) {
    const saved = await updatePendingPasteReviewDraft(
      state.pendingReviewMessage,
      text,
      generation,
    );
    if (generation !== state.latestSaveGeneration) {
      let corrected = saved;
      let correctedText = text;
      while (
        generation !== state.latestSaveGeneration &&
        state.latestSaveText &&
        correctedText !== state.latestSaveText
      ) {
        correctedText = state.latestSaveText;
        // Each corrected write must observe the prior CAS result before
        // choosing the next revision, so these retries are intentionally serial.
        corrected = await updatePendingPasteReviewDraft(
          corrected,
          correctedText,
          state.latestSaveGeneration,
        );
      }
      return;
    }
    state.pendingReviewMessage = saved;
    return;
  }

  try {
    const saved = await createPendingPasteReview(
      conversationId,
      text,
      pendingReviewId ?? undefined,
    );
    if (
      !state.pendingReviewMessage ||
      generation === state.latestSaveGeneration
    ) {
      state.pendingReviewMessage = saved;
    }
  } catch (error) {
    const saveError = String(error).toLowerCase();
    const isDuplicateMessageId =
      saveError.includes("unique constraint failed") &&
      saveError.includes("chat_messages.id");
    if (
      !isDuplicateMessageId ||
      generation !== state.latestSaveGeneration ||
      !pendingReviewId
    ) {
      throw error;
    }
    state.pendingReviewMessage = await updatePendingPasteReviewDraftById(
      conversationId,
      pendingReviewId,
      text,
      generation,
    );
  }
};

const openPendingPasteInChats = async (
  state: PasteReviewState,
  conversationId: string,
  pendingReviewId: string | null,
  reviewedText: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) return;
  state.activeOpenSaves += 1;
  try {
    await saveLatestReviewDraft(
      state,
      conversationId,
      pendingReviewId,
      reviewedText,
    );
    if (signal?.aborted) return;
    state.openedPendingPaste = true;
    try {
      await emit("open-pill-conversation", {
        conversationId,
        pendingPasteReview: true,
      });
    } catch (error) {
      // The durable card is still available in Chats even if native surfacing
      // or navigation could not be requested.
      getLogger().warning(`Could not open the Paste review in Chats: ${error}`);
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
  } finally {
    state.activeOpenSaves -= 1;
    await cancelUnusedPendingReview(state);
  }
};

const completePasteReview = async (
  state: PasteReviewState,
  text: string | null,
  conversationId?: string,
): Promise<Record<string, unknown>> => {
  if (state.openedPendingPaste) {
    // Open may have timed out at the window-event boundary while the review
    // remained available for another decision. Preserve a later Insert edit
    // on the durable card, but never paste after Chats may have taken focus.
    if (text?.trim() && conversationId) {
      await saveLatestReviewDraft(state, conversationId, null, text);
    }
    return { awaitingManualPaste: true };
  }
  if (state.copiedReviewedText) return { copiedToClipboard: true };
  if (state.reviewExpired) {
    throw new Error(
      "Paste transcript review expired before a decision was made.",
    );
  }
  if (state.reviewFailed) {
    throw new Error("Paste transcript review could not be completed.");
  }
  if (!text?.trim()) return { canceled: true };

  let outcome: PasteOutcome;
  try {
    outcome = await invoke<PasteOutcome>("paste", { text, keybind: null });
  } catch (error) {
    // The insert never reached the target, so this is exactly the case the
    // saved review exists for: the text is only recoverable by hand. The save
    // is best-effort, and the insert's own failure is what the caller has to
    // see, so a failed write is logged rather than reported.
    await savePendingPasteReview(conversationId ?? "", text);
    throw error;
  }
  if (outcome === "copied_to_clipboard") {
    // The focused target could not take the text, so nothing landed and the
    // clipboard fallback has to be turned into a deliberate hand-off.
    await savePendingPasteReview(conversationId ?? "", text);
    return { copiedToClipboard: true };
  }
  return {};
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
    const state = createPasteReviewState();
    const conversationId = context?.conversationId;
    const pendingReviewId = conversationId ? createId() : null;
    const reviewOptions = {
      onCopy: () => {
        state.copiedReviewedText = true;
      },
      onExpire: () => {
        state.reviewExpired = true;
      },
      onFailure: () => {
        state.reviewFailed = true;
      },
      ...(conversationId
        ? {
            onOpen: (reviewedText: string, signal?: AbortSignal) =>
              openPendingPasteInChats(
                state,
                conversationId,
                pendingReviewId,
                reviewedText,
                signal,
              ),
          }
        : {}),
    };
    let text: string | null;
    try {
      text =
        getAppState().userPrefs?.reviewBeforeInsert === true
          ? await reviewTranscriptBeforeInsert(
              requestedText,
              "assistant-tool",
              reviewOptions,
            )
          : requestedText;
    } finally {
      state.reviewResolved = true;
      await cancelUnusedPendingReview(state);
    }
    return completePasteReview(state, text, conversationId);
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

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

const PASTE_REVIEW_CLEANUP_TIMEOUT_MS = 5_000;
const PASTE_CHAT_NAVIGATION_TIMEOUT_MS = 5_000;

const requestOpenChatsNavigation = (conversationId: string): void => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Opening Chats for the Paste review timed out")),
      PASTE_CHAT_NAVIGATION_TIMEOUT_MS,
    );
  });
  void Promise.race([
    emit("open-pill-conversation", {
      conversationId,
      pendingPasteReview: true,
    }),
    timedOut,
  ])
    .catch((error: unknown) => {
      getLogger().warning(
        `Could not open the saved Paste review in Chats: ${error}`,
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
    })
    .finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
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

const cancelUnusedPendingReview = (state: PasteReviewState): void => {
  if (
    !state.reviewResolved ||
    state.activeOpenSaves > 0 ||
    state.openedPendingPaste ||
    !state.pendingReviewMessage
  ) {
    return;
  }
  const unusedMessage = state.pendingReviewMessage;
  // Clear synchronously so a concurrent completion cannot launch duplicate
  // cleanup; this is best-effort bookkeeping and must not delay Insert/Copy.
  state.pendingReviewMessage = null;
  const cleanup = cancelPendingPasteReview(unusedMessage, "");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Paste review cleanup timed out")),
      PASTE_REVIEW_CLEANUP_TIMEOUT_MS,
    );
  });
  void Promise.race([cleanup, timedOut])
    .catch((error: unknown) => {
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
    })
    .finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
};

const reconcileLatestExistingReviewDraft = async (
  state: PasteReviewState,
  saved: ChatMessage,
  savedText: string,
  generation: number,
): Promise<ChatMessage> => {
  const latestText = state.latestSaveText;
  if (
    generation === state.latestSaveGeneration ||
    !latestText ||
    savedText === latestText
  ) {
    return saved;
  }

  // Every correction must observe the previous CAS result before its next revision.
  const corrected = await updatePendingPasteReviewDraft(
    saved,
    latestText,
    state.latestSaveGeneration,
  );
  return reconcileLatestExistingReviewDraft(
    state,
    corrected,
    latestText,
    generation,
  );
};

const updateLatestExistingReviewDraft = async (
  state: PasteReviewState,
  message: ChatMessage,
  text: string,
  generation: number,
): Promise<void> => {
  const saved = await updatePendingPasteReviewDraft(message, text, generation);
  state.pendingReviewMessage = await reconcileLatestExistingReviewDraft(
    state,
    saved,
    text,
    generation,
  );
};

const createOrRecoverReviewDraft = async (
  state: PasteReviewState,
  conversationId: string,
  pendingReviewId: string | null,
  text: string,
  generation: number,
): Promise<void> => {
  try {
    const saved = await createPendingPasteReview(
      conversationId,
      text,
      pendingReviewId ?? undefined,
    );
    if (generation === state.latestSaveGeneration) {
      state.pendingReviewMessage = saved;
    }
  } catch (error) {
    const duplicateId =
      String(error).toLowerCase().includes("unique constraint failed") &&
      String(error).toLowerCase().includes("chat_messages.id");
    if (
      !duplicateId ||
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

const saveLatestReviewDraft = async (
  state: PasteReviewState,
  conversationId: string,
  pendingReviewId: string | null,
  text: string,
): Promise<void> => {
  // Reuse one id so a retry can recover a committed create after a timed-out write.
  const generation = ++state.latestSaveGeneration;
  state.latestSaveText = text;
  if (state.pendingReviewMessage) {
    await updateLatestExistingReviewDraft(
      state,
      state.pendingReviewMessage,
      text,
      generation,
    );
    return;
  }
  await createOrRecoverReviewDraft(
    state,
    conversationId,
    pendingReviewId,
    text,
    generation,
  );
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
    if (signal?.aborted || state.reviewResolved) return;
    state.openedPendingPaste = true;
    // Durable persistence completes the review. Navigation is best-effort and
    // must not leave Open retryable after the card is already committed.
    requestOpenChatsNavigation(conversationId);
  } finally {
    state.activeOpenSaves -= 1;
    cancelUnusedPendingReview(state);
  }
};

const completeOpenedPendingPaste = async (
  state: PasteReviewState,
  text: string | null,
  conversationId?: string,
): Promise<Record<string, unknown>> => {
  // Open may time out while the review remains available for another decision.
  if (text?.trim() && conversationId) {
    await saveLatestReviewDraft(state, conversationId, null, text);
  }
  return { awaitingManualPaste: true };
};

const pasteReviewedText = async (
  conversationId: string | undefined,
  text: string,
): Promise<Record<string, unknown>> => {
  let outcome: PasteOutcome;
  try {
    outcome = await invoke<PasteOutcome>("paste", { text, keybind: null });
  } catch (error) {
    // A failed insert leaves the reviewed text recoverable via a saved card.
    await savePendingPasteReview(conversationId ?? "", text);
    throw error;
  }
  if (outcome === "copied_to_clipboard") {
    await savePendingPasteReview(conversationId ?? "", text);
    return { copiedToClipboard: true };
  }
  return {};
};

const completePasteReview = async (
  state: PasteReviewState,
  text: string | null,
  conversationId?: string,
): Promise<Record<string, unknown>> => {
  if (state.openedPendingPaste) {
    return completeOpenedPendingPaste(state, text, conversationId);
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
  return pasteReviewedText(conversationId, text);
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
      cancelUnusedPendingReview(state);
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

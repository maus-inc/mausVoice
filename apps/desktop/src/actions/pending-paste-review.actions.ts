import type { ChatMessage } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { createId } from "../utils/id.utils";
import { nowIso } from "../utils/date.utils";
import { createChatMessage, updateChatMessage } from "./chat.actions";

export const PENDING_PASTE_REVIEW_TYPE = "pending-paste-review";

type PendingPasteReviewStatus = "pending" | "copied" | "canceled";

export type PendingPasteReviewMetadata = {
  type: typeof PENDING_PASTE_REVIEW_TYPE;
  toolName: "paste";
  toolCallState: "awaiting-manual-paste";
  text: string;
  status: PendingPasteReviewStatus;
};

export const getPendingPasteReview = (
  metadata: Record<string, unknown> | null,
): PendingPasteReviewMetadata | null => {
  if (
    metadata?.type !== PENDING_PASTE_REVIEW_TYPE ||
    metadata.toolName !== "paste" ||
    metadata.toolCallState !== "awaiting-manual-paste" ||
    typeof metadata.text !== "string" ||
    (metadata.status !== "pending" &&
      metadata.status !== "copied" &&
      metadata.status !== "canceled")
  ) {
    return null;
  }

  return {
    type: PENDING_PASTE_REVIEW_TYPE,
    toolName: "paste",
    toolCallState: "awaiting-manual-paste",
    text: metadata.text,
    status: metadata.status,
  };
};

/**
 * Store an edited agent Paste request before the native review card closes.
 *
 * A main-window click cannot safely insert into the app that was focused when
 * the agent requested the paste: opening Chats moved focus to mausVoice. The
 * saved action therefore offers a deliberate clipboard hand-off rather than
 * pretending it can still paste into that original app.
 */
export const createPendingPasteReview = async (
  conversationId: string,
  text: string,
): Promise<ChatMessage> => {
  if (!text.trim()) {
    throw new Error("Cannot save an empty Paste review");
  }

  return createChatMessage({
    id: createId(),
    conversationId,
    role: "system",
    content: "",
    createdAt: nowIso(),
    metadata: {
      type: PENDING_PASTE_REVIEW_TYPE,
      toolName: "paste",
      toolCallState: "awaiting-manual-paste",
      text,
      status: "pending",
    } satisfies PendingPasteReviewMetadata,
  });
};

const updatePendingPasteReview = async (
  message: ChatMessage,
  pending: PendingPasteReviewMetadata,
  text: string,
  status: PendingPasteReviewStatus,
): Promise<ChatMessage> =>
  updateChatMessage({
    ...message,
    metadata: {
      ...pending,
      text,
      status,
    } satisfies PendingPasteReviewMetadata,
  });

/**
 * Copy the saved text for a manual paste. The latest edit is persisted before
 * touching the clipboard, so a clipboard failure leaves a retryable, durable
 * pending action rather than losing the user's wording.
 */
export const copyPendingPasteReview = async (
  message: ChatMessage,
  text: string,
): Promise<void> => {
  const pending = getPendingPasteReview(message.metadata);
  if (pending?.status !== "pending") {
    throw new Error("This Paste review is no longer pending");
  }
  if (!text.trim()) {
    throw new Error("Cannot copy an empty Paste review");
  }

  const saved = await updatePendingPasteReview(
    message,
    pending,
    text,
    "pending",
  );
  await invoke("copy_to_clipboard", { text });
  await updatePendingPasteReview(saved, pending, text, "copied");
};

/** Mark a saved Paste review as intentionally dismissed, preserving its text. */
export const cancelPendingPasteReview = async (
  message: ChatMessage,
  text: string,
): Promise<void> => {
  const pending = getPendingPasteReview(message.metadata);
  if (pending?.status !== "pending") {
    throw new Error("This Paste review is no longer pending");
  }

  // Cancel dismisses the action, not its durable record. Treat an empty editor
  // as no replacement so a deletion immediately before Cancel cannot erase the
  // text that Open preserved from the pill.
  const preservedText = text.trim() ? text : pending.text;
  await updatePendingPasteReview(message, pending, preservedText, "canceled");
};

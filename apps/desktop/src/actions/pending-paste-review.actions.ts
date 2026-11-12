import type { ChatMessage } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { getIntl } from "../i18n/intl";
import { createId } from "../utils/id.utils";
import { nowIso } from "../utils/date.utils";
import { LocalChatMessageRepo } from "../repos/chat-message.repo";
import { createChatMessage, updateChatMessage } from "./chat.actions";

export const PENDING_PASTE_REVIEW_TYPE = "pending-paste-review";

type PendingPasteReviewStatus = "pending" | "copied" | "canceled";

export type PendingPasteReviewMetadata = {
  type: typeof PENDING_PASTE_REVIEW_TYPE;
  toolName: "paste";
  toolCallState: "awaiting-manual-paste";
  text: string;
  status: PendingPasteReviewStatus;
  draftRevision: number;
};

const isValidDraftRevision = (revision: unknown): boolean =>
  revision === undefined ||
  (typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0);

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
      metadata.status !== "canceled") ||
    !isValidDraftRevision(metadata.draftRevision)
  ) {
    return null;
  }

  return {
    type: PENDING_PASTE_REVIEW_TYPE,
    toolName: "paste",
    toolCallState: "awaiting-manual-paste",
    text: metadata.text,
    status: metadata.status,
    draftRevision: Number(metadata.draftRevision ?? 0),
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
  id = createId(),
): Promise<ChatMessage> => {
  if (!text.trim()) {
    // The bubble hands a thrown Error to `showErrorSnackbar`, which stringifies
    // it, so every message here is user-facing copy and comes from intl.
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "Cannot save an empty Paste review",
      }),
    );
  }

  return createChatMessage({
    id,
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
      draftRevision: 0,
    } satisfies PendingPasteReviewMetadata,
  });
};

const updatePendingPasteReview = (
  message: ChatMessage,
  pending: PendingPasteReviewMetadata,
  text: string,
  status: PendingPasteReviewStatus,
  draftRevision = pending.draftRevision + 1,
): Promise<ChatMessage> =>
  updateChatMessage({
    ...message,
    metadata: {
      ...pending,
      text,
      status,
      draftRevision,
    } satisfies PendingPasteReviewMetadata,
  });

/**
 * Recover a retry whose earlier create committed but never returned. The
 * conversation-scoped lookup avoids applying a synthetic update to a missing
 * or differently owned card; the native write rechecks ownership atomically.
 */
export const updatePendingPasteReviewDraftById = async (
  conversationId: string,
  id: string,
  text: string,
  draftRevision: number,
): Promise<ChatMessage> => {
  const messages = await new LocalChatMessageRepo().listChatMessages(
    conversationId,
  );
  const existing = messages.find((message) => message.id === id);
  if (existing?.conversationId !== conversationId) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }
  return updatePendingPasteReviewDraft(existing, text, draftRevision);
};

/** Persist a newer pill draft on an existing, still-pending Paste review card. */
export async function updatePendingPasteReviewDraft(
  message: ChatMessage,
  text: string,
  requestedRevision?: number,
): Promise<ChatMessage> {
  const pending = getPendingPasteReview(message.metadata);
  if (pending?.status !== "pending") {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }
  if (!text.trim()) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "Cannot save an empty Paste review",
      }),
    );
  }

  const draftRevision = requestedRevision ?? pending.draftRevision + 1;
  if (!Number.isSafeInteger(draftRevision) || draftRevision < 1) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }
  const saved = await updatePendingPasteReview(
    message,
    pending,
    text,
    "pending",
    draftRevision,
  );
  const savedPending = getPendingPasteReview(saved.metadata);
  if (
    savedPending?.status !== "pending" ||
    savedPending.draftRevision < draftRevision
  ) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }
  return saved;
}

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
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }
  if (!text.trim()) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "Cannot copy an empty Paste review",
      }),
    );
  }

  const saved = await updatePendingPasteReview(
    message,
    pending,
    text,
    "pending",
  );
  const savedPending = getPendingPasteReview(saved.metadata);
  if (savedPending?.status !== "pending" || savedPending.text !== text) {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }
  await invoke("copy_to_clipboard", { text });
  await updatePendingPasteReview(saved, savedPending, text, "copied");
};

/** Mark a saved Paste review as intentionally dismissed, preserving its text. */
export const cancelPendingPasteReview = async (
  message: ChatMessage,
  text: string,
): Promise<void> => {
  const pending = getPendingPasteReview(message.metadata);
  if (pending?.status !== "pending") {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }

  // Cancel dismisses the action, not its durable record. Treat an empty editor
  // as no replacement so a deletion immediately before Cancel cannot erase the
  // text that Open preserved from the pill.
  let saved = await updatePendingPasteReview(
    message,
    pending,
    text.trim() ? text : pending.text,
    "canceled",
  );
  let savedPending = getPendingPasteReview(saved.metadata);
  // Each retry uses the revision returned by the previous write; these writes
  // must stay sequential so a fresh CAS can observe and preserve the newest text.
  for (
    let attempt = 0;
    savedPending?.status === "pending" && attempt < 3;
    attempt += 1
  ) {
    saved = await updatePendingPasteReview(
      saved,
      savedPending,
      savedPending.text,
      "canceled",
    );
    savedPending = getPendingPasteReview(saved.metadata);
  }
  if (savedPending?.status !== "canceled") {
    throw new Error(
      getIntl().formatMessage({
        defaultMessage: "This Paste review is no longer pending",
      }),
    );
  }
};

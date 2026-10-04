/**
 * Which window size the native pill needs for what it is currently showing.
 *
 * The pill window is resized from the desktop side, and the wrong size clips
 * the panel: a transcript under review needs the assistant panel with its
 * text entry, the same room typing to the assistant needs, even when no
 * assistant session is running.
 */
export type PillWindowSize =
  "dictation" | "assistant_compact" | "assistant_expanded" | "assistant_typing";

export const resolvePillWindowSize = ({
  hasPendingReview,
  isAgentRecording,
  isAssistantTyping,
  pillHasContent,
}: {
  /** A transcript is waiting on the pill for insert, copy or cancel. */
  hasPendingReview: boolean;
  isAgentRecording: boolean;
  isAssistantTyping: boolean;
  /** The assistant panel has messages or a pending tool permission. */
  pillHasContent: boolean;
}): PillWindowSize => {
  if (hasPendingReview) return "assistant_typing";
  if (!isAgentRecording) return "dictation";
  if (isAssistantTyping) return "assistant_typing";
  return pillHasContent ? "assistant_expanded" : "assistant_compact";
};

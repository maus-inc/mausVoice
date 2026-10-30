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
  // Tested BEFORE the recording check, and that order is the whole point of this function.
  //
  // Type mode is entered by STOPPING the recording: `DictationSideEffects` runs
  // `systemVolumeDim.endRecording()` and `invoke("stop_recording")` and only then sets
  // `assistantInputMode = "type"`. That path does NOT clear `activeRecordingMode`
  // (only `clearRecordingState` does, and it is not called), so `isAgentRecording`
  // can still be true while the assistant is typing -- and a
  // `!isAgentRecording` early return above the typing branch answered "dictation", leaving the
  // pill at dictation size while the assistant was typing. That is what this file's header
  // says must not happen: typing needs the same room as a pending review "even when no
  // assistant session is running".
  if (isAssistantTyping) return "assistant_typing";
  if (!isAgentRecording) return "dictation";
  return pillHasContent ? "assistant_expanded" : "assistant_compact";
};

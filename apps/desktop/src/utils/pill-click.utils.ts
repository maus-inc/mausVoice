/**
 * What a click on the native pill body means for the dictation session.
 *
 * The native pills register one full-body `ClickAction::Pill` region in every
 * phase, so a click while a session is paused arrives as the same
 * `on-click-dictate` event as a click while idle or recording. Routing that
 * straight into `ActivationController.toggle()` deactivated the session, which
 * users read as "clicking the pill cancelled my dictation". Cancel stays an
 * explicit, separate control (`CancelDictation`), so a body click during pause
 * must resume instead.
 */
export type PillBodyClickIntent = "ignore" | "resume" | "toggle";

export const resolvePillBodyClickIntent = ({
  isMainWindow,
  isDictationInteractable,
  isPaused,
}: {
  isMainWindow: boolean;
  /** False while the session is stopping or dictation is locked. */
  isDictationInteractable: boolean;
  isPaused: boolean;
}): PillBodyClickIntent => {
  if (!isMainWindow || !isDictationInteractable) return "ignore";
  return isPaused ? "resume" : "toggle";
};

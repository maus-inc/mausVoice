export type ToastType = "info" | "error";

export const TOAST_ACTIONS = [
  "upgrade",
  "open_agent_settings",
  "open_post_processing_settings",
  "surface_window",
  "open_transcriptions",
  "confirm_cancel_transcription",
  "auto_learn_accept",
  "auto_learn_reject",
] as const;

export type ToastAction = (typeof TOAST_ACTIONS)[number];

export type ToastActionPayload = {
  action: ToastAction;
  /**
   * The auto-learn proposal the clicked prompt belonged to, as a string so it
   * survives the wire it travels on (see `encodeToastActionToken`).
   *
   * A prompt outlives the proposal it was raised for: the pill dismisses the
   * toast on its own timer, and the store's proposal is cleared on its TTL. A
   * click that arrives afterwards belongs to a prompt the app has already moved
   * past, and answering it with whatever proposal is current now would add or
   * deny a term the user was never shown.
   */
  proposalId?: string;
};

/**
 * Separates the action from its proposal id inside the pill's action token.
 *
 * The native pill treats `action` as an opaque string: it stores it verbatim on
 * the flash and hands the same string back on a click, without parsing it. The
 * id therefore rides inside that token rather than beside it, which is what
 * lets a click name the prompt it came from without a change to any of the
 * three pill crates. The token is only ever read back through
 * `decodeToastActionToken`.
 */
const PROPOSAL_ID_SEPARATOR = "#";

/**
 * Encode an action and the proposal it belongs to as the single token the pill
 * echoes back. A token with no id stays exactly the bare action name, so a
 * prompt that has nothing to correlate keeps its previous wire form.
 */
export const encodeToastActionToken = (
  action: ToastAction,
  proposalId?: string,
): string =>
  proposalId === undefined
    ? action
    : `${action}${PROPOSAL_ID_SEPARATOR}${proposalId}`;

/**
 * Read a token the pill echoed back into an action and, when it carries one,
 * the proposal the clicked prompt belonged to.
 *
 * A token this app did not produce (an unknown action, or one from a pill that
 * predates the id) is passed through as the action and matched against nothing,
 * which is exactly how an uncorrelatable click behaved before.
 */
export const decodeToastActionToken = (token: string): ToastActionPayload => {
  const separator = token.lastIndexOf(PROPOSAL_ID_SEPARATOR);
  if (separator === -1) {
    return { action: token as ToastAction };
  }
  const name = token.slice(0, separator);
  if (!(TOAST_ACTIONS as readonly string[]).includes(name)) {
    return { action: token as ToastAction };
  }
  return {
    action: name as ToastAction,
    proposalId: token.slice(separator + 1),
  };
};

import type { StylingMode } from "@maus-inc/types";

/**
 * In-dictation style-switch channels. Pill chevrons, Left/Right while holding
 * the dictate key, and dedicated cycle hotkeys all collapse to a `cycle`
 * transition. A "switch to style" hotkey is a `select` transition. Both
 * transitions write the same `user.selectedToneId` slot.
 */
export type WritingStyleSwitchChannel =
  "pill" | "arrows" | "cycle-hotkey" | "hotkey";

export type WritingStyleSwitchRequest =
  | { channel: "pill" | "arrows" | "cycle-hotkey"; direction: 1 | -1 }
  | { channel: "hotkey"; toneId: string };

export type WritingStyleTransition =
  { kind: "cycle"; direction: 1 | -1 } | { kind: "select"; toneId: string };

export const toWritingStyleTransition = (
  request: WritingStyleSwitchRequest,
): WritingStyleTransition => {
  if (request.channel === "hotkey") {
    return { kind: "select", toneId: request.toneId };
  }
  return { kind: "cycle", direction: request.direction };
};

export type InDictationArrow = "LeftArrow" | "RightArrow";

/**
 * Decides whether a Left/Right press while the dictate key is held should
 * cycle the writing style. Returns the cycle direction, or null when the
 * press must be ignored.
 */
export const resolveInDictationArrowStyleSwitch = (args: {
  enabled: boolean;
  isMainWindow: boolean;
  isActiveDictateSession: boolean;
  isManualStyling: boolean;
  activationHeld: boolean;
  newlyPressed: InDictationArrow | null;
}): "forward" | "backward" | null => {
  if (
    !args.enabled ||
    !args.isMainWindow ||
    !args.isActiveDictateSession ||
    !args.isManualStyling ||
    !args.activationHeld ||
    !args.newlyPressed
  ) {
    return null;
  }
  return args.newlyPressed === "LeftArrow" ? "backward" : "forward";
};

/**
 * Inputs for choosing the tone that post-processing applies to the utterance
 * being finalized.
 *
 * Semantics (manual mode):
 * - The FINAL output uses the tone selected at STOP, so a mid-utterance
 *   switch (any channel) styles this utterance, not just the pill label.
 * - A switch that arrives after stop has snapshotted the tone loses for
 *   this utterance (`toneIdAtStop` is already frozen). The live selection
 *   still updates for the next utterance.
 * - Already-inserted realtime text is never restyled. Streaming sessions
 *   skip post-processing; a mid-stream switch applies from the next
 *   interim segment only (atomic per segment).
 *
 * Automatic mode uses the app-target tone captured at stop and ignores
 * manual switches.
 */
export type FinalizeToneArgs = {
  stylingMode: StylingMode;
  /** Manual selection when recording started. Fallback only. */
  toneIdAtStart: string | null;
  /** Manual selection snapshotted when stop was initiated. */
  toneIdAtStop: string | null;
  /** Live selection at the moment we ask (may have changed after stop). */
  liveSelectedToneId: string | null;
  /** App-target tone captured at stop. Automatic mode only. */
  appTargetToneId: string | null;
  /**
   * True when realtime interim text has already been inserted. Does not
   * change the finalize tone; callers must not re-post-process streamed
   * sessions.
   */
  hasInsertedInterimText?: boolean;
};

export type FinalizeToneDecision = {
  toneId: string | null;
  /** Always false: already-inserted realtime text is never rewritten. */
  restyleInsertedText: false;
};

/**
 * Tone used for the FINAL post-processed output of the current utterance.
 *
 * Manual: stop-time selection. Mid-utterance switches are already reflected
 * in `toneIdAtStop`. A switch after stop lives only in `liveSelectedToneId`
 * and is ignored for this utterance.
 *
 * Automatic: `appTargetToneId`, regardless of any manual selection.
 */
export const getEffectiveToneIdAtFinalize = (
  args: FinalizeToneArgs,
): FinalizeToneDecision => {
  if (args.stylingMode !== "manual") {
    return { toneId: args.appTargetToneId, restyleInsertedText: false };
  }

  return {
    toneId: args.toneIdAtStop ?? args.toneIdAtStart,
    restyleInsertedText: false,
  };
};

/**
 * A switch that arrives after stop has locked the utterance tone does not
 * change this utterance. It still updates the live selection for next time.
 */
export const doesLateStyleSwitchAffectCurrentUtterance = (
  switchArrivedAfterStopSnapshot: boolean,
): boolean => {
  return !switchArrivedAfterStopSnapshot;
};

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
 * First arrow that just went down. Keys in both sets are already lowercased.
 * Left wins if both edges fire in the same update (they should not).
 */
export const resolveNewlyPressedDictationArrow = (
  current: Set<string>,
  previous: Set<string>,
): InDictationArrow | null => {
  if (current.has("leftarrow") && !previous.has("leftarrow")) {
    return "LeftArrow";
  }
  if (current.has("rightarrow") && !previous.has("rightarrow")) {
    return "RightArrow";
  }
  return null;
};

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
 * - Prefer the tone snapshotted at STOP, so a mid-utterance switch (any
 *   channel) styles this utterance, not just the pill label.
 * - A switch that arrives after that snapshot lives only in
 *   `liveSelectedToneId` and is ignored while a stop/start snapshot exists.
 * - If both snapshots are missing (teardown/start race), fall back to the
 *   live selection so finalize never drops a known tone on the floor.
 *
 * Automatic mode prefers the app-target tone captured at stop. If the
 * focused app has no assigned tone, fall back to `liveSelectedToneId` so
 * finalize still has a concrete style (labeling and post-processing both
 * assume one). Manual mode never consults `appTargetToneId`: that value
 * is the automatic-mode assignment and must not override an explicit
 * manual selection. Styling mode is read at finalize, so a mid-session
 * toggle to automatic picks up the app tone via the automatic branch.
 *
 * Already-inserted realtime text is never restyled here: streamed sessions
 * skip post-processing in DictationStrategy, and a mid-stream switch
 * applies from the next interim segment only.
 */
export type FinalizeToneArgs = {
  stylingMode: StylingMode;
  /** Manual selection when recording started. Fallback if stop is missing. */
  toneIdAtStart: string | null;
  /** Manual selection snapshotted when stop was initiated. */
  toneIdAtStop: string | null;
  /**
   * Live selection at the moment we ask.
   * Manual: last-resort fallback when both snapshots are missing.
   * Automatic: last-resort fallback when the app has no assigned tone.
   */
  liveSelectedToneId: string | null;
  /** App-target tone captured at stop. Automatic mode only. */
  appTargetToneId: string | null;
};

/**
 * Tone used for the FINAL post-processed output of the current utterance.
 *
 * Manual: `toneIdAtStop ?? toneIdAtStart ?? liveSelectedToneId`.
 * Never `appTargetToneId` — that belongs only to automatic mode.
 * Automatic: `appTargetToneId ?? liveSelectedToneId`.
 */
export const getEffectiveToneIdAtFinalize = (
  args: FinalizeToneArgs,
): string | null => {
  if (args.stylingMode !== "manual") {
    return args.appTargetToneId ?? args.liveSelectedToneId;
  }
  return args.toneIdAtStop ?? args.toneIdAtStart ?? args.liveSelectedToneId;
};

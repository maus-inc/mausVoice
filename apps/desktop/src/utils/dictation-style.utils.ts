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
 * Contract (manual mode): ONE style applies to the WHOLE utterance, and the
 * latest style chosen while recording wins. The tone snapshotted when STOP was
 * initiated is that style, so switching mid-dictation restyles the entire
 * final transcript (not just the words spoken after the switch) and, because
 * the switch also writes `user.selectedToneId`, it becomes the default for the
 * next recording. Switches that arrive after stop live in `liveSelectedToneId`
 * and are ignored for this utterance; `toneIdAtStart` is the last-resort
 * fallback if no stop snapshot was taken.
 *
 * Automatic mode prefers the app-target tone captured at stop. If the
 * focused app has no assigned tone, fall back to `liveSelectedToneId` so
 * finalize still has a concrete style (labeling and post-processing both
 * assume one). Manual mode never consults `appTargetToneId`: that value is
 * the automatic-mode assignment and must not override an explicit manual
 * selection. Styling mode is read at finalize, so a mid-session toggle to
 * automatic picks up the app tone via the automatic branch.
 *
 * Already-inserted realtime text is never restyled here: streamed sessions
 * skip post-processing in DictationStrategy, and a mid-stream switch applies
 * from the next interim segment only.
 */
export type FinalizeToneArgs = {
  stylingMode: StylingMode;
  /** Manual selection when recording started. Fallback only. */
  toneIdAtStart: string | null;
  /**
   * Manual selection snapshotted when stop was initiated, including any
   * mid-dictation switch. The authoritative utterance style.
   */
  toneIdAtStop: string | null;
  /** Live selection at the moment we ask. Fallback when stop never snapshotted. */
  liveSelectedToneId: string | null;
  /** App-target tone captured at stop. Automatic mode only. */
  appTargetToneId: string | null;
};

/**
 * Tone used for the FINAL post-processed output of the current utterance.
 *
 * Manual: `toneIdAtStop ?? liveSelectedToneId ?? toneIdAtStart`.
 * Never `appTargetToneId` — that belongs only to automatic mode.
 * Automatic: `appTargetToneId ?? liveSelectedToneId`.
 */
export const getEffectiveToneIdAtFinalize = (
  args: FinalizeToneArgs,
): string | null => {
  if (args.stylingMode !== "manual") {
    return args.appTargetToneId ?? args.liveSelectedToneId;
  }
  return args.toneIdAtStop ?? args.liveSelectedToneId ?? args.toneIdAtStart;
};

/**
 * Per-utterance tone snapshots. Seed at recording start, overwrite stop
 * when stop is initiated, clear on abort / type-mode / stop teardown.
 */
export type UtteranceToneSnapshotStore = {
  seed: (toneId: string | null) => void;
  snapshotAtStop: (toneId: string | null) => void;
  clear: () => void;
  read: () => { start: string | null; stop: string | null };
};

export const createUtteranceToneSnapshots = (): UtteranceToneSnapshotStore => {
  let start: string | null = null;
  let stop: string | null = null;
  return {
    seed(toneId) {
      start = toneId;
      stop = toneId;
    },
    snapshotAtStop(toneId) {
      stop = toneId;
    },
    clear() {
      start = null;
      stop = null;
    },
    read() {
      return { start, stop };
    },
  };
};

/** True when every key of any combo is currently held (keys already lowercased). */
export const isActivationComboHeld = (
  combos: string[][],
  keysHeldLower: Set<string>,
): boolean =>
  combos.some((combo) =>
    combo.every((key) => keysHeldLower.has(key.toLowerCase())),
  );

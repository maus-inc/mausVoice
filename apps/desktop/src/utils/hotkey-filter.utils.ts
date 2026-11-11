/**
 * Hotkey spam filter for the dictation pill.
 *
 * Uses real production action names from keyboard.utils.ts.
 * - Never filters DICTATE_HOTKEY / AGENT_DICTATE_HOTKEY (hold-to-talk
 *   and agent toggle already handle their own debouncing)
 * - Never filters CANCEL_TRANSCRIPTION_HOTKEY (must always be stoppable)
 * - Debounces auto-repeat of non-toggle fire actions (style switches)
 *   while recording, using release-before-refire tracking
 * - resetHotkeyFilter() is called on abort/stop via hardResetHotkeyState
 */

import {
  DICTATE_HOTKEY,
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  STYLE_SWITCH_ACTION_PREFIXES,
} from "./keyboard.utils";

// ── Constants ────────────────────────────────────────────────────────────

/** Window in ms during which identical non-toggle triggers are collapsed. */
const DEBOUNCE_WINDOW_MS = 300;

/** Actions that are NEVER filtered (substring match on action name). */
const ALWAYS_ALLOW_ACTIONS: readonly string[] = [
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  AGENT_DICTATE_HOTKEY,
];

/**
 * Style-switch action name prefixes. These ARE debounced while recording
 * but must be releasable. Shared with keyboard.utils so the reverse mapping
 * (getStyleSwitchActionNamesForKey) and this matcher can't drift apart.
 */
const STYLE_SWITCH_PREFIXES = STYLE_SWITCH_ACTION_PREFIXES;

// ── Module-level state ───────────────────────────────────────────────────

const lastFireTimestamps = new Map<string, number>();
const heldActions = new Set<string>();

// ── Public API ───────────────────────────────────────────────────────────

export interface HotkeyFilterResult {
  allowed: boolean;
  reason: string;
}

/**
 * Evaluate whether a hotkey trigger should be allowed to proceed.
 *
 * @param actionName - The hotkey action name (e.g. "dictate",
 *   "cancel-transcription", "switch-writing-style-forward").
 * @param isRecording - Whether the pill is currently in an active recording
 *   state (overlayPhase === "recording").
 */
export const evaluateHotkeyTrigger = (
  actionName: string,
  isRecording: boolean,
): HotkeyFilterResult => {
  const now = Date.now();
  const lower = actionName.toLowerCase();

  // 1. Always allow critical actions (dictation toggle, cancel, agent)
  if (ALWAYS_ALLOW_ACTIONS.some((a) => lower.includes(a))) {
    lastFireTimestamps.delete(actionName);
    heldActions.delete(actionName);
    return { allowed: true, reason: "critical action always allowed" };
  }

  // 2. When not recording, pass everything through
  if (!isRecording) {
    lastFireTimestamps.delete(actionName);
    heldActions.delete(actionName);
    return { allowed: true, reason: "not recording, allowing all" };
  }

  // 3. WHILE RECORDING: only debounce style-switch actions
  const isStyleAction = STYLE_SWITCH_PREFIXES.some((p) => lower.startsWith(p));
  if (!isStyleAction) {
    // Allow non-style, non-critical actions through (shouldn't normally happen)
    return { allowed: true, reason: "non-style action while recording" };
  }

  // Debounce style switches
  const lastFire = lastFireTimestamps.get(actionName) ?? 0;
  const elapsed = now - lastFire;

  if (elapsed < DEBOUNCE_WINDOW_MS) {
    return {
      allowed: false,
      reason: `style-switch debounce: ${elapsed}ms < ${DEBOUNCE_WINDOW_MS}ms`,
    };
  }

  // Release-before-refire for same style action
  if (heldActions.has(actionName)) {
    return {
      allowed: false,
      reason: "style-switch held, release required before refire",
    };
  }

  lastFireTimestamps.set(actionName, now);
  heldActions.add(actionName);
  return { allowed: true, reason: "style-switch allowed" };
};

/**
 * Signal that a style-switch hotkey's physical key has been released.
 *
 * Release is keyed to a specific action name (see
 * `getStyleSwitchActionNamesForKey`), so a style action only becomes
 * re-firable once ITS key is up — releasing on "all keys up" would never fire
 * during hold-to-talk dictation, where the dictate key stays held. A full
 * reset (session abort/stop) is `resetHotkeyFilter`.
 */
export const releaseHotkey = (actionName: string): void => {
  if (
    STYLE_SWITCH_PREFIXES.some((p) => actionName.toLowerCase().startsWith(p))
  ) {
    // Key-up releases the physical hold only. Retain the timestamp so a
    // modifier-only/partial release cannot bypass the 300 ms debounce window.
    heldActions.delete(actionName);
  }
};

/**
 * Reset all filter state. Called from hardResetHotkeyState on abort/stop
 * so stale held state does not leak across dictation sessions.
 */
export const resetHotkeyFilter = (): void => {
  lastFireTimestamps.clear();
  heldActions.clear();
};

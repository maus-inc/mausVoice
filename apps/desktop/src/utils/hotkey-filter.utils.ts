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
 * but must be releasable.
 */
const STYLE_SWITCH_PREFIXES: readonly string[] = [
  "switch-writing-style-",
  "switch-to-style:",
];

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
  const isStyleAction = STYLE_SWITCH_PREFIXES.some((p) =>
    lower.startsWith(p),
  );
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
 * Signal that a style-switch hotkey has been released.
 * Pass "__all__" to clear all held state (e.g., when all physical keys are up).
 */
export const releaseHotkey = (actionName: string): void => {
  if (actionName === "__all__") {
    heldActions.clear();
    lastFireTimestamps.clear();
    return;
  }
  if (STYLE_SWITCH_PREFIXES.some((p) => actionName.toLowerCase().startsWith(p))) {
    heldActions.delete(actionName);
    lastFireTimestamps.delete(actionName);
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
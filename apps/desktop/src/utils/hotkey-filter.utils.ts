/**
 * Hotkey spam filter for the dictation pill.
 *
 * While the pill is in an active recording state, repeated/noisy hotkey triggers
 * for the SAME action are coalesced/dropped so they cannot restart dictation,
 * spam style switches, or cause flicker — while legitimate distinct hotkeys
 * (stop, cancel, style cycle) keep working instantly.
 *
 * DESIGN
 * - The filter operates at the bridge_hotkey_trigger level in AppSideEffects.
 * - When the pill is recording, identical trigger events for the same hotkey
 *   that arrive within the DEBOUNCE_WINDOW_MS are dropped (except stop/cancel).
 * - A hotkey must be released and re-pressed before it can fire again
 *   (release-before-refire requirement) to prevent auto-repeat storms.
 * - The hotkey name convention uses prefixes: dictation actions start with
 *   "dictate:" or "transcribe:", and stop actions contain "stop" or "cancel".
 *
 * All filter state is module-level (no singletons or React state needed).
 */

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Window in ms during which identical hotkey triggers are collapsed while
 * the pill is recording.
 */
const DEBOUNCE_WINDOW_MS = 300;

/** Set of hotkey action fragments that must NEVER be filtered. */
const ALWAYS_ALLOW_SUBSTRINGS = ["stop", "cancel", "release", "abort"];

// ── Module-level state ───────────────────────────────────────────────────

/**
 * Tracks the last fire timestamp per hotkey name so we can debounce.
 * Key: hotkey name (string), Value: timestamp of last processed trigger.
 */
const lastFireTimestamps = new Map<string, number>();

/**
 * Tracks whether a hotkey is "held" (pressed but not yet released).
 * A held hotkey's triggers are collapsed; release resets this.
 */
const heldHotkeys = new Set<string>();

// ── Public API ───────────────────────────────────────────────────────────

export interface HotkeyFilterResult {
  /** Whether the trigger should be processed. */
  allowed: boolean;
  /** Reason for the decision (for logging). */
  reason: string;
}

/**
 * Evaluate whether a hotkey trigger should be allowed to proceed.
 *
 * @param hotkey - The hotkey name (e.g. "dictate:toggle", "style:cycle").
 * @param isRecording - Whether the pill is currently in an active recording
 *   state (overlayPhase === "recording").
 * @returns A result indicating whether the trigger should be processed.
 */
export const evaluateHotkeyTrigger = (
  hotkey: string,
  isRecording: boolean,
): HotkeyFilterResult => {
  const now = Date.now();

  // Always allow stop/cancel actions regardless of state.
  if (ALWAYS_ALLOW_SUBSTRINGS.some((sub) => hotkey.toLowerCase().includes(sub))) {
    lastFireTimestamps.set(hotkey, now);
    return { allowed: true, reason: "stop/cancel action always allowed" };
  }

  // When not recording, pass everything through (reset debounce state).
  if (!isRecording) {
    lastFireTimestamps.set(hotkey, now);
    heldHotkeys.delete(hotkey);
    return { allowed: true, reason: "not recording, allowing all" };
  }

  // WHILE RECORDING: apply debounce
  const lastFire = lastFireTimestamps.get(hotkey) ?? 0;
  const elapsed = now - lastFire;

  if (elapsed < DEBOUNCE_WINDOW_MS) {
    // Hotkey fired again too quickly while still recording — drop it.
    return {
      allowed: false,
      reason: `debounce: only ${elapsed}ms since last fire (window ${DEBOUNCE_WINDOW_MS}ms)`,
    };
  }

  // Check release-before-refire: if the hotkey is still marked as held,
  // and we haven't seen a release event, drop repeat triggers.
  if (heldHotkeys.has(hotkey)) {
    return {
      allowed: false,
      reason: "hotkey still held, release required before refire",
    };
  }

  // Allowed: record the fire time and mark as held.
  lastFireTimestamps.set(hotkey, now);
  heldHotkeys.add(hotkey);
  return { allowed: true, reason: "allowed" };
};

/**
 * Signal that a hotkey has been released (key up, or release event received).
 * This clears the "held" state AND the debounce timestamp so the hotkey
 * can fire again on the very next press without waiting for the debounce
 * window to expire.
 */
export const releaseHotkey = (hotkey: string): void => {
  heldHotkeys.delete(hotkey);
  lastFireTimestamps.delete(hotkey);
};

/**
 * Reset all filter state (e.g., on dictation stop/cleanup).
 */
export const resetHotkeyFilter = (): void => {
  lastFireTimestamps.clear();
  heldHotkeys.clear();
};
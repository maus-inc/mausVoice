type ModifierFamily = "alt" | "shift" | "control";

const MAX_TAP_MS = 350;
const DOUBLE_TAP_WINDOW_MS = 400;

const normalizeKey = (key: string) => key.toLowerCase();

const modifierFamilyOf = (key: string): ModifierFamily | null => {
  const lower = normalizeKey(key);
  if (lower.startsWith("alt")) return "alt";
  if (lower.startsWith("shift")) return "shift";
  if (lower.startsWith("control")) return "control";
  return null;
};

type Tap = {
  family: ModifierFamily;
  key: string;
  startedAt: number;
};

type PendingTap = {
  family: ModifierFamily;
  releasedAt: number;
};

export type LocateGestureDetector = {
  /**
   * Feeds one held-key snapshot. `allowed` is the configured modifier family,
   * or null when the gesture is disabled. Returns true only when the snapshot
   * completes a double tap of that family.
   */
  update(keys: string[], now: number, allowed: ModifierFamily | null): boolean;
  reset(): void;
};

/**
 * Detects two taps of the configured modifier family from held-key snapshots.
 *
 * A tap is a lone modifier held for at most `MAX_TAP_MS`. The second tap fires
 * only when it starts within `DOUBLE_TAP_WINDOW_MS` of the first release. Any
 * other key, a different modifier, or a long hold clears the sequence.
 * Autorepeat never reaches this detector because it does not change the held
 * set.
 */
export const createLocateGestureDetector = (): LocateGestureDetector => {
  const pressed = new Set<string>();
  let tap: Tap | null = null;
  let pending: PendingTap | null = null;

  const release = (key: string, now: number): boolean => {
    if (!pressed.delete(key)) return false;
    if (tap?.key !== key) return false;

    const { family, startedAt } = tap;
    tap = null;
    if (now - startedAt > MAX_TAP_MS) {
      pending = null;
      return false;
    }
    const isSecondTap =
      pending?.family === family &&
      startedAt - pending.releasedAt <= DOUBLE_TAP_WINDOW_MS;
    pending = isSecondTap ? null : { family, releasedAt: now };
    return isSecondTap;
  };

  const press = (key: string, now: number, allowed: ModifierFamily | null) => {
    if (pressed.has(key)) return;
    pressed.add(key);
    const family = modifierFamilyOf(key);
    if (family && family === allowed && pressed.size === 1) {
      tap = { family, key, startedAt: now };
    } else {
      tap = null;
      pending = null;
    }
  };

  return {
    update(keys, now, allowed) {
      if (allowed === null) {
        pressed.clear();
        tap = null;
        pending = null;
        return false;
      }
      const next = new Set(keys.map(normalizeKey));
      let fired = false;
      for (const key of Array.from(pressed)) {
        if (!next.has(key)) fired = release(key, now) || fired;
      }
      for (const key of next) {
        press(key, now, allowed);
      }
      return fired;
    },
    reset() {
      pressed.clear();
      tap = null;
      pending = null;
    },
  };
};

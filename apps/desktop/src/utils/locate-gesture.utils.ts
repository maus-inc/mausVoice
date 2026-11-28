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
  let activeFamily: ModifierFamily | null = null;

  /** True when this tap starts close enough behind the previous one to pair. */
  const pairsWithPending = (family: ModifierFamily, startedAt: number) =>
    pending?.family === family &&
    family === activeFamily &&
    startedAt - pending.releasedAt <= DOUBLE_TAP_WINDOW_MS;

  const isLongHold = (startedAt: number, now: number) =>
    now - startedAt > MAX_TAP_MS;

  const clear = () => {
    pressed.clear();
    tap = null;
    pending = null;
  };

  const release = (key: string, now: number): boolean => {
    if (!pressed.delete(key)) return false;
    if (tap?.key !== key) return false;

    const { family, startedAt } = tap;
    // The preference can change while a modifier is still held, and no key
    // snapshot arrives to notice it. Dropping the sequence here stops a
    // release from completing a pair for a family that is no longer selected.
    if (family !== activeFamily) {
      pending = null;
      return false;
    }
    tap = null;
    if (isLongHold(startedAt, now)) {
      pending = null;
      return false;
    }
    const fired = pairsWithPending(family, startedAt);
    pending = fired ? null : { family, releasedAt: now };
    return fired;
  };

  /** Releases every held key absent from the new snapshot. */
  const releaseMissing = (next: Set<string>, now: number) => {
    let fired = false;
    for (const key of Array.from(pressed)) {
      if (next.has(key)) continue;
      fired = release(key, now) || fired;
    }
    return fired;
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
      if (allowed !== activeFamily) {
        activeFamily = allowed;
        if (allowed === null) {
          // Nothing is tracked while the gesture is off, so a key released
          // during that window cannot linger as pressed.
          clear();
          return false;
        }
        // A different family invalidates the sequence in flight, even when the
        // held keys have not changed. The held keys stay in `pressed`, because
        // clearing them would hand a long hold a fresh start time on the next
        // snapshot and let it complete a pair as if it were a short tap.
        tap = null;
        pending = null;
      }
      const next = new Set(keys.map(normalizeKey));
      const fired = releaseMissing(next, now);
      for (const key of next) {
        press(key, now, allowed);
      }
      return fired;
    },
    /**
     * Drop the sequence in flight without forgetting which keys are held.
     *
     * `reset` runs while the gesture is off, and a modifier can stay down
     * across that window. Clearing `pressed` would let the next snapshot read
     * that same hold as a fresh press, so its release would count as the first
     * tap of a pair and one later tap would fire locate. Keeping the held set
     * and clearing the family makes the next snapshot resume from the keys that
     * are actually down.
     */
    reset() {
      tap = null;
      pending = null;
      activeFamily = null;
    },
  };
};

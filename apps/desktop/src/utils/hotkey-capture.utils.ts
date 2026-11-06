/** Preserve key order while ignoring duplicate native key-down reports. */
export const uniqueHeldKeys = (keys: string[]): string[] => [...new Set(keys)];

/** Record growth or replacement, but not a release of already-recorded keys. */
export const hasNewHeldKeys = (held: string[], last: string[]): boolean => {
  const lastSet = new Set(last);
  return held.length > last.length || held.some((key) => !lastSet.has(key));
};

/** Decide how a native key snapshot advances the recorder without UI side effects. */
export const advanceHotkeyCapture = ({
  focused,
  interacted,
  keysHeld,
  previousHeld,
  lastEmitted,
}: {
  focused: boolean;
  interacted: boolean;
  keysHeld: string[];
  previousHeld: string[];
  lastEmitted: string[] | undefined;
}): {
  previousHeld: string[];
  lastEmitted: string[] | undefined;
} & (
  | { action: "idle" | "cancel" }
  | { action: "release"; released: string[] }
  | { action: "record"; emitted: string[] | undefined }
) => {
  if (!focused) return { action: "idle", previousHeld: [], lastEmitted };
  const held = uniqueHeldKeys(keysHeld);
  const last = interacted ? lastEmitted : [];
  if (
    interacted &&
    previousHeld.length > 0 &&
    held.length < previousHeld.length
  ) {
    return {
      action: "release",
      released: previousHeld,
      previousHeld: [],
      lastEmitted: last,
    };
  }
  if (held.length === 0)
    return { action: "idle", previousHeld: held, lastEmitted: last };
  if (held.length === 1 && held[0] === "Escape") {
    return { action: "cancel", previousHeld: held, lastEmitted: last };
  }
  const emitted = hasNewHeldKeys(held, last ?? []) ? held : undefined;
  return {
    action: "record",
    emitted,
    previousHeld: held,
    lastEmitted: emitted ?? last,
  };
};

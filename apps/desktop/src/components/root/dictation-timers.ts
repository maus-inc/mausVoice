/** Shared reference to a timeout owned by the recording lifecycle. */
export type TimerRef = { current: ReturnType<typeof setTimeout> | null };
const owners = new WeakMap<TimerRef, object>();

export const hasOwnedTimer = (ref: TimerRef): boolean => ref.current !== null;

/** Release ownership before clearing so the handle cannot be cancelled twice. */
export function clearOwnedTimer(ref: TimerRef): void {
  const handle = ref.current;
  owners.delete(ref);
  if (handle === null) return;
  ref.current = null;
  clearTimeout(handle);
}

/** Ignore a retired callback and release a fired handle before invoking work. */
export function scheduleOwnedTimer(
  ref: TimerRef,
  callback: () => void,
  delay: number,
): void {
  clearOwnedTimer(ref);
  const owner = {};
  const handle = setTimeout(() => {
    if (owners.get(ref) !== owner) return;
    owners.delete(ref);
    ref.current = null;
    callback();
  }, delay);
  owners.set(ref, owner);
  ref.current = handle;
}

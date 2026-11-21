import { commands } from "@maus-inc/desktop-native-apis";

let pending: Promise<void> | null = null;
let appliedFiniteLinger: number | null = null;

function enqueue<T>(change: () => T | Promise<T>): Promise<T> {
  const previous = pending;
  const result = (async () => {
    if (previous) await previous;
    return change();
  })();
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  pending = tail;
  return result.finally(() => {
    if (pending === tail) pending = null;
  });
}

export function queueMicrophonePolicyChange<T>(
  change: () => T | Promise<T>,
): Promise<T> {
  return enqueue(() => {
    // A warm open or close can replace the policy written by the previous press.
    appliedFiniteLinger = null;
    return change();
  });
}

export function syncFiniteMicrophoneLinger(
  readLinger: () => number | null,
): Promise<void> {
  return enqueue(async () => {
    const linger = readLinger();
    if (linger === null || linger === appliedFiniteLinger) return;
    await commands.setMicrophoneLinger(linger);
    appliedFiniteLinger = linger;
  });
}

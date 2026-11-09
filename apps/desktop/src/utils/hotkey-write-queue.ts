import type { Hotkey } from "@maus-inc/types";

let queue: Promise<void> = Promise.resolve();
const optimisticRevisions = new Map<string, number>();

/** Track changes published before their queued persistence finishes. */
export const markOptimisticHotkeyWrite = (action: string, id?: string) => {
  optimisticRevisions.set(action, (optimisticRevisions.get(action) ?? 0) + 1);
  const pending = id === undefined ? undefined : onboardingWrites.get(id);
  if (pending) pending.revision += 1;
};

export const optimisticHotkeyRevision = (prefix: string) =>
  [...optimisticRevisions].reduce(
    (total, [action, revision]) =>
      total + (action.startsWith(prefix) ? revision : 0),
    0,
  );

/** Order shortcut persistence across editors, including after an editor unmounts. */
export const enqueueHotkeyWrite = <T>(write: () => Promise<T>): Promise<T> => {
  const result = queue.then(write);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

// Transaction bookkeeping lives with the shared queue because saves can
// outlive a component or a store reset. It is not persisted or UI state.
const onboardingWrites = new Map<
  string,
  { count: number; revision: number; saved: Hotkey | undefined }
>();
let pendingOnboardingWrites = 0;
let onboardingNeedsSync = false;

export const beginOnboardingHotkeyWrite = (
  id: string,
  previous: Hotkey | undefined,
) => {
  const pending = onboardingWrites.get(id) ?? {
    count: 0,
    revision: 0,
    saved: previous,
  };
  pending.count += 1;
  pendingOnboardingWrites += 1;
  onboardingWrites.set(id, pending);
};

export const onboardingHotkeyRevision = (id: string) =>
  onboardingWrites.get(id)?.revision;
export const onboardingSavedHotkey = (id: string) =>
  onboardingWrites.get(id)?.saved;
export const setOnboardingSavedHotkey = (id: string, value?: Hotkey) => {
  const pending = onboardingWrites.get(id);
  if (pending) pending.saved = value;
};
export const markOnboardingSyncNeeded = () => {
  onboardingNeedsSync = true;
};
export const takeOnboardingSyncNeeded = () => {
  if (pendingOnboardingWrites !== 0 || !onboardingNeedsSync) return false;
  onboardingNeedsSync = false;
  return true;
};
export const finishOnboardingHotkeyWrite = (id: string) => {
  const pending = onboardingWrites.get(id);
  if (!pending) return;
  pendingOnboardingWrites -= 1;
  pending.count -= 1;
  if (pending.count === 0) onboardingWrites.delete(id);
};

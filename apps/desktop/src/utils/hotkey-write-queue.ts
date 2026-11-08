let queue: Promise<void> = Promise.resolve();
const optimisticRevisions = new Map<string, number>();

/** Track changes published before their queued persistence finishes. */
export const markOptimisticHotkeyWrite = (action: string) => {
  optimisticRevisions.set(action, (optimisticRevisions.get(action) ?? 0) + 1);
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

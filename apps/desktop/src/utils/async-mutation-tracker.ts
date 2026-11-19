export const createAsyncMutationTracker = () => {
  let revision = 0;
  const pending = new Set<Promise<unknown>>();

  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    revision += 1;
    const work = Promise.resolve().then(operation);
    const tracked = work.finally(() => {
      pending.delete(tracked);
      revision += 1;
    });
    pending.add(tracked);
    return tracked;
  };

  const wait = (): Promise<void> => {
    if (!pending.size) return Promise.resolve();
    return Promise.allSettled(pending).then(wait);
  };

  return { track, wait, revision: () => revision };
};

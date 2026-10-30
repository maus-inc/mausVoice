// A list read must not replace optimistic edits with an older database view.
let revision = 0;
const pending = new Set<Promise<unknown>>();

export const dictionaryMutationRevision = () => revision;

export const trackDictionaryMutation = <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  revision += 1;
  const work = Promise.resolve().then(operation);
  const tracked = work.finally(() => {
    pending.delete(tracked);
    revision += 1;
  });
  pending.add(tracked);
  return tracked;
};

export const waitForDictionaryMutations = async (): Promise<void> => {
  while (pending.size) await Promise.allSettled(pending);
};

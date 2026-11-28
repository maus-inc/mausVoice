/**
 * A minimal promise-chain serializer. Tasks enqueued through `enqueue` run one
 * at a time, in submission order, and each task observes the outcome of the
 * previous one only through the shared side effects it performs (never through
 * a stale closure value). A rejected task does not poison the chain: the next
 * enqueued task still runs.
 */
export type MutationQueue = {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
};

export const createMutationQueue = (): MutationQueue => {
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return { enqueue };
};

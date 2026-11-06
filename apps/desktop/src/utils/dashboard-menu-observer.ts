type Unlisten = ReturnType<typeof observeDashboardMenu>;

/** Own each window listener independently, including late or failed registrations. */
export function observeDashboardMenu({
  subscribe,
  push,
  onError,
}: {
  subscribe: Array<(listener: () => void) => Promise<() => void>>;
  push: () => Promise<unknown>;
  onError: (error: unknown) => void;
}): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unlisteners: Unlisten[] = [];
  const release = (unlisten: Unlisten) => {
    try {
      unlisten();
    } catch (error) {
      onError(error);
    }
  };
  const sync = () => {
    if (!active) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        void push().catch(onError);
      } catch (error) {
        onError(error);
      }
    }, 50);
  };
  sync();
  for (const register of subscribe) {
    try {
      void register(sync)
        .then((unlisten) => {
          if (active) unlisteners.push(unlisten);
          else release(unlisten);
        })
        .catch(onError);
    } catch (error) {
      onError(error);
    }
  }
  return () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    for (const unlisten of unlisteners) release(unlisten);
    unlisteners.length = 0;
  };
}

/** Release an asynchronously registered listener even if its owner unmounted first. */
export const createWindowListenerGuard = () => {
  let canceled = false;
  let unlisten: (() => void) | undefined;
  return {
    isCanceled: () => canceled,
    registered: (release: () => void) => {
      if (canceled) release();
      else unlisten = release;
    },
    dispose: () => {
      canceled = true;
      unlisten?.();
      unlisten = undefined;
    },
  };
};

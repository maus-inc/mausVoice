const WARNING_DELAY_MS = 5_000;
const WARNING_DURATION_MS = 30_000;
const RETRY_DELAY_MS = 5_000;

/** Warn while a cancelled microphone's release is pending or unconfirmed. */
export function monitorAbortRelease({
  isCurrent,
  show,
  dismiss,
  immediately,
  retry,
}: {
  isCurrent: () => boolean;
  show: (duration: number, isCurrent: () => boolean) => void;
  dismiss: () => void;
  immediately: boolean;
  retry?: () => Promise<void>;
}): {
  failed: () => void;
  watch: (release: Promise<void>) => void;
  isFailed: () => boolean;
} {
  let failed = false;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryActive = false;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    if (interval !== null) clearInterval(interval);
    if (retryTimer !== null) clearTimeout(retryTimer);
    timer = null;
    interval = null;
    retryTimer = null;
  };
  const warn = () => {
    if (!isCurrent()) {
      clear();
      return;
    }
    shown = true;
    show(WARNING_DURATION_MS, isCurrent);
  };
  const begin = () => {
    timer = null;
    warn();
    if (isCurrent()) interval = setInterval(warn, WARNING_DURATION_MS);
  };
  const scheduleRetry = () => {
    if (!retry || retryActive || retryTimer !== null || !isCurrent()) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!isCurrent()) {
        clear();
        return;
      }
      // A scoped discard is safe to retry after explicit cancellation. Do not
      // dispatch another while one is pending, even if the driver hangs.
      retryActive = true;
      void Promise.resolve()
        .then(retry)
        .then(
          () => {
            retryActive = false;
            failed = false;
            clear();
            if (shown) dismiss();
          },
          () => {
            retryActive = false;
            scheduleRetry();
          },
        );
    }, RETRY_DELAY_MS);
  };
  const fail = () => {
    failed = true;
    clear();
    warn();
    if (retry && isCurrent()) {
      interval = setInterval(warn, WARNING_DURATION_MS);
      scheduleRetry();
    }
  };
  if (immediately) begin();
  else timer = setTimeout(begin, WARNING_DELAY_MS);
  return {
    failed: fail,
    watch: (release) => {
      void release.then(() => {
        if (!failed) {
          clear();
          if (shown) dismiss();
        }
      }, fail);
    },
    isFailed: () => failed,
  };
}

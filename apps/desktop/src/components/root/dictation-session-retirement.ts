import { getLogger } from "../../utils/log.utils";

/** Retire a recording when the session captured at its start is no longer current. */
export function watchRecordingSession(
  subscribe: (check: () => void) => () => void,
  sessionRef: { current: (() => boolean) | null },
  abort: () => Promise<void>,
): () => void {
  let active = true;
  let scheduled: (() => boolean) | null = null;
  const check = () => {
    const session = sessionRef.current;
    if (!session || session() || scheduled === session) return;
    scheduled = session;
    // Store listeners run during state publication. Defer cleanup so its state
    // writes cannot re-enter that publication, but run before another UI event.
    queueMicrotask(() => {
      if (scheduled === session) scheduled = null;
      if (!active || sessionRef.current !== session || session()) return;
      void abort().catch(() => {
        getLogger().warning("Could not retire recording after an auth change");
      });
    });
  };
  const unsubscribe = subscribe(check);
  check();
  return () => {
    active = false;
    unsubscribe();
  };
}

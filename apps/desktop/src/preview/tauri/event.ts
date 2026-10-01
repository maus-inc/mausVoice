export type Event<T> = {
  event: string;
  id: number;
  payload: T;
};

export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;

type Listener = EventCallback<unknown>;
const listeners = new Map<string, Set<Listener>>();
let nextListenerId = 1;

export const listen = <T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> => {
  const set = listeners.get(event) ?? new Set<Listener>();
  const listener = handler as EventCallback<unknown>;
  set.add(listener);
  listeners.set(event, set);

  return Promise.resolve(() => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
  });
};

export const once = async <T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> => {
  let unlisten: UnlistenFn | undefined;
  unlisten = await listen<T>(event, (payload) => {
    unlisten?.();
    handler(payload);
  });
  return unlisten;
};

export const emit = <T>(event: string, payload?: T): Promise<void> => {
  const eventId = nextListenerId++;
  try {
    for (const handler of listeners.get(event) ?? []) {
      handler({ event, id: eventId, payload });
    }
  } catch (error) {
    // Tauri's `emit` rejects when a listener throws, and callers such as
    // ComposerPage mount rely on `emit(...).catch(...)` to absorb that, so the
    // failure has to arrive as a rejection rather than a synchronous throw.
    return Promise.reject(error);
  }
  return Promise.resolve();
};

// Window routing is intentionally local in the browser: a preview only owns
// its current tab and never creates a privileged native window.
export const emitTo = async <T>(
  _target: string,
  event: string,
  payload?: T,
): Promise<void> => emit(event, payload);

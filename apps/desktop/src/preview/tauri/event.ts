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

export const listen = async <T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> => {
  const set = listeners.get(event) ?? new Set<Listener>();
  const listener = handler as EventCallback<unknown>;
  set.add(listener);
  listeners.set(event, set);

  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
  };
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

export const emit = async <T>(event: string, payload?: T): Promise<void> => {
  const eventId = nextListenerId++;
  for (const handler of listeners.get(event) ?? []) {
    handler({ event, id: eventId, payload });
  }
};

// Window routing is intentionally local in the browser: a preview only owns
// its current tab and never creates a privileged native window.
export const emitTo = async <T>(
  _target: string,
  event: string,
  payload?: T,
): Promise<void> => emit(event, payload);

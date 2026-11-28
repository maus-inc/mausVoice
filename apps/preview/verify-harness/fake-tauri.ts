/**
 * The native bridge the verification harnesses install in place of Tauri.
 *
 * The app reaches the native side through `@tauri-apps/api/core`'s `invoke`,
 * which is a thin wrapper over `window.__TAURI_INTERNALS__.invoke`, and it
 * subscribes through `plugin:event|listen`, which registers its callback with
 * `transformCallback` first. Installing those objects IS the seam the real
 * WebView uses, so a harness can hand every command a fake answer without
 * mocking a single component.
 *
 * The scaffolding is the same in every harness: an event callback table, the
 * window metadata the local-data gate reads, and a promise-shaped `invoke`.
 * Only the answers differ, so only the answers are passed in.
 */

/** What a harness answers for one command. Throwing rejects, as the real side does. */
export type FakeInvoke = (cmd: string, args: any) => unknown;

export const installFakeTauri = (invoke: FakeInvoke): void => {
  const eventCallbacks = new Map<number, (payload: unknown) => void>();
  let nextEventId = 1;

  const internals = window as any;
  internals.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  internals.__TAURI_INTERNALS__ = {
    // The harnesses only ever render the main window, and the local-data write
    // gate refuses writes from any other label.
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: (callback: (payload: unknown) => void) => {
      const id = nextEventId++;
      eventCallbacks.set(id, callback);
      return id;
    },
    runCallback: (id: number, payload: unknown) => {
      eventCallbacks.get(id)?.(payload);
    },
    unregisterCallback: (id: number) => {
      eventCallbacks.delete(id);
    },
    // Always a promise, and a throw from the harness's answer becomes a
    // rejection, because the real `invoke` never returns a plain value.
    invoke: (cmd: string, args: any) =>
      Promise.resolve().then(() => invoke(cmd, args)),
  };
};

import type { invokePreviewCommand as InvokePreviewCommand } from "../runtime";

export type InvokeArgs = Record<string, unknown>;

/**
 * Resolved on first use rather than imported at module scope.
 *
 * This module stands in for `@tauri-apps/api/core`, which is a leaf dependency
 * that much of the app imports. The preview runtime reaches the whole app, so a
 * static import here closes a cycle through every one of those importers. That
 * cycle already broke the preview: `env.utils` -> the `desktop-utils` barrel ->
 * `updater` -> this module -> the runtime -> the store -> `login.state`, whose
 * module-scope `isEmulators()` then ran while `env.utils` was still evaluating.
 * A dynamic import keeps the dependency one-way at module scope, so evaluation
 * order can never produce a temporal dead zone.
 */
const runtime = () =>
  import("../runtime").then(
    (module): typeof InvokePreviewCommand => module.invokePreviewCommand,
  );

export const invoke = async <T>(
  command: string,
  args?: InvokeArgs,
): Promise<T> => (await runtime())(command, args);

/** A small in-memory equivalent of Tauri's streaming command channel. */
export class Channel<T> {
  #onmessage: ((message: T) => void) | null = null;

  set onmessage(listener: ((message: T) => void) | null) {
    this.#onmessage = listener;
  }

  get onmessage(): ((message: T) => void) | null {
    return this.#onmessage;
  }

  send(message: T): void {
    this.#onmessage?.(message);
  }
}

/**
 * Base class retained for code that owns a native resource in desktop builds.
 * The browser preview has no external resource to release.
 */
export class Resource {
  readonly rid: number;

  constructor(rid = 0) {
    this.rid = rid;
  }

  // `Resource.close` is async in the real API; the preview has nothing to
  // release but must still settle asynchronously for those callers.
  close(): Promise<void> {
    return Promise.resolve();
  }
}

import { invokePreviewCommand } from "../runtime";

export type InvokeArgs = Record<string, unknown>;

export const invoke = <T>(command: string, args?: InvokeArgs): Promise<T> =>
  invokePreviewCommand<T>(command, args);

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

  async close(): Promise<void> {
    return undefined;
  }
}

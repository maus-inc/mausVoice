/**
 * Abort scope for a transcription session's own requests.
 *
 * The pretranscriber manages the spans it dispatches, but the final
 * whole-recording request is issued by the session itself, and that request can
 * still be running when the user discards the dictation. Without a signal, the
 * sidecar keeps inferring audio nobody will read and the next recording queues
 * behind it, so the session aborts this scope in `cleanup`.
 */
export class SessionAbortScope {
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isAborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** Aborts the scope. Safe to call more than once. */
  abort(): void {
    this.controller.abort();
  }
}

import { createId } from "./id.utils";
import {
  acquireLocalBrowserRecording,
  releaseLocalBrowserRecording,
} from "./local-recording-activity";

type RecordingInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** Reserves native ownership until the browser recognizer has ended. */
export class BrowserRecordingLease {
  private readonly ownerId = createId();
  private stopped = false;
  private admissionToken: number | null = null;
  private acquired = false;
  private acquiring = false;
  private releasePromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly invokeFn: RecordingInvoke) {}

  async acquire(): Promise<void> {
    if (this.stopped || !acquireLocalBrowserRecording(this.invokeFn, this)) {
      throw new Error("A recording is already in progress");
    }
    this.acquired = true;
    this.acquiring = true;
    try {
      const generation = await this.invokeFn("recording_generation", {
        ownerId: this.ownerId,
      });
      if (!Number.isSafeInteger(generation) || (generation as number) < 0)
        throw new Error("Invalid recording generation");
      this.admissionToken = generation as number;
      if (this.stopped) throw new Error("Recording start was cancelled");
      await this.invokeFn("claim_browser_recording", {
        ownerId: this.ownerId,
        generation,
      });
      if (this.stopped) throw new Error("Recording start was cancelled");
    } catch (error) {
      void this.release().catch(() => undefined);
      throw error;
    } finally {
      await this.finishAcquisition();
    }
  }

  private async finishAcquisition(): Promise<void> {
    // An earlier release can overtake a delayed admission request.
    if (this.stopped && this.releasePromise) {
      await this.releasePromise.catch(() => undefined);
    }
    this.acquiring = false;
    if (this.stopped) void this.release().catch(() => undefined);
  }

  release(): Promise<void> {
    this.stopped = true;
    if (!this.acquired) return Promise.resolve();
    if (this.admissionToken === null) {
      // Without a token the browser claim has not been dispatched.
      releaseLocalBrowserRecording(this.invokeFn, this);
      if (!this.acquiring) this.acquired = false;
      return Promise.resolve();
    }
    if (this.releasePromise) return this.releasePromise;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.releasePromise = Promise.resolve()
      .then(() =>
        this.invokeFn("release_browser_recording", {
          ownerId: this.ownerId,
          generation: this.admissionToken,
        }),
      )
      .then(() => {
        if (!this.acquiring) {
          this.acquired = false;
          releaseLocalBrowserRecording(this.invokeFn, this);
        }
      })
      .catch((error: unknown) => {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.release().catch(() => undefined);
        }, 1_000);
        throw error;
      })
      .finally(() => {
        this.releasePromise = null;
      });
    return this.releasePromise;
  }
}

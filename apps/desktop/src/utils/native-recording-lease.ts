import { invoke } from "@tauri-apps/api/core";
import type { StopRecordingResponse } from "../types/transcription-session.types";
import { createId } from "./id.utils";
import {
  acquireLocalNativeRecording,
  releaseLocalNativeRecording,
} from "./local-recording-activity";
import { tryDecodeStopRecordingPayload } from "./recorded-audio.utils";

type RecordingInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const STOP_RETRY_DELAY_MS = 5_000;
// Match the native recovery retention horizon; do not keep failed-stop audio
// in a still-referenced lease indefinitely.
const RECOVERED_STOP_LIFETIME_MS = 60_000;
const MAX_RECOVERED_STOPS = 8;
const MAX_RECOVERED_STOP_BYTES = 128 * 1024 * 1024;
let recoveredStopCount = 0;
let recoveredStopBytes = 0;

// Keep failed releases reachable even if a component unmounts. A new lease
// retries those exact owners before asking native to admit another recording.
// Failed normal stops use scoped recovery; explicit cancellation and failed
// starts use destructive discard instead.
const pendingReleases = new WeakMap<
  RecordingInvoke,
  Set<NativeRecordingLease>
>();

function releasesFor(invokeFn: RecordingInvoke): Set<NativeRecordingLease> {
  let releases = pendingReleases.get(invokeFn);
  if (!releases) {
    releases = new Set();
    pendingReleases.set(invokeFn, releases);
  }
  return releases;
}

const SAMPLE_RATE_CEILING = 0x80000000;

/**
 * The sample rate a start reply proved, or a rejection. Anything else means the
 * reply cannot be trusted to describe a capture that opened.
 */
const sampleRateFromStartResponse = (result: unknown): number => {
  if (!result || typeof result !== "object" || !("sampleRate" in result)) {
    throw new Error("Invalid recording start response");
  }
  const { sampleRate } = result as { sampleRate: unknown };
  if (
    typeof sampleRate !== "number" ||
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate >= SAMPLE_RATE_CEILING
  ) {
    throw new Error("Invalid recording start response");
  }
  return sampleRate;
};

/**
 * A stop reply is usable when it decodes, carries an integer rate below the
 * failure-flag bit, and does not claim silence for a capture that already
 * reported audio at a known rate.
 */
const isValidStopResponse = (
  decoded: StopRecordingResponse | null,
  confirmedSampleRate: number | null,
): decoded is StopRecordingResponse => {
  if (!decoded) return false;
  const rate = decoded.sampleRate;
  if (typeof rate !== "number" || !Number.isInteger(rate)) return false;
  if (rate < 0 || rate >= SAMPLE_RATE_CEILING) return false;
  if (rate > 0) return true;
  return decoded.samples.length === 0 && confirmedSampleRate === null;
};

/**
 * Resolve `true` when `work` settles before `timeoutMs`, `false` when the wait
 * expires. A rejection counts as settled: the caller inspects the result itself.
 */
const settlesWithin = (
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void work.then(
      () => finish(true),
      () => finish(false),
    );
  });

export class NativeRecordingLease {
  readonly ownerId: string;
  private admissionToken: number | null = null;
  get generation(): number | null {
    return this.admissionToken;
  }
  private startPromise: Promise<{ sampleRate: number }> | null = null;
  private stopPromise: Promise<StopRecordingResponse> | null = null;
  private discardPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private recoveredStop: StopRecordingResponse | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryDeadline = 0;
  private retainedBytes = 0;
  private recoveryExpired = false;
  private confirmedSampleRate: number | null = null;
  private failedNormalStop = false;
  private cancelPromise: Promise<void> | null = null;
  private cancelStop: (() => void) | null = null;
  private stopped = false;
  // Unlike a failed stop, an explicit cancellation must not later be promoted
  // into a normal stop by a racing caller.
  private cancelled = false;
  private released = false;
  // A failed capture can be returned before native hardware release finishes.
  private releaseConfirmed = false;

  constructor(
    private readonly invokeFn: RecordingInvoke = invoke,
    ownerId = createId(),
  ) {
    this.ownerId = ownerId;
  }

  start(
    preferredMicrophone: string | null,
    waitForRelease = false,
    onDispatched?: () => void,
    shouldDispatch?: () => boolean,
  ): Promise<{ sampleRate: number }> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped)
      return Promise.reject(new Error("Recording lease is closed"));
    if (!acquireLocalNativeRecording(this.invokeFn, this)) {
      return Promise.reject(new Error("A recording is already in progress"));
    }
    // Install the shared promise before invoking a transport, which may call
    // back into this lease synchronously during dispatch.
    let resolveStart!: (value: { sampleRate: number }) => void;
    let rejectStart!: (error: unknown) => void;
    this.startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    let admissionDispatched = false;
    const pending = releasesFor(this.invokeFn);
    const admission = () => {
      if (this.stopped) {
        return Promise.reject(new Error("Recording lease is closed"));
      }
      admissionDispatched = true;
      return this.requestAdmission().then(
        (generation) => {
          if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
            releaseLocalNativeRecording(this.invokeFn, this);
            throw new Error("Invalid recording generation");
          }
          this.admissionToken = generation as number;
          let allowed: boolean;
          try {
            allowed =
              !this.stopped && (shouldDispatch?.() ?? true) && !this.stopped;
          } catch (error) {
            this.releaseUnusedAdmission();
            throw error;
          }
          if (!allowed) {
            this.releaseUnusedAdmission();
            throw new Error("Recording lease is closed");
          }
          return this.dispatchStart(
            this.admissionToken,
            preferredMicrophone,
            waitForRelease,
            onDispatched,
          );
        },
        (error: unknown) => {
          // Without an admission token no start was dispatched, so a lost
          // reservation reply cannot have opened capture.
          releaseLocalNativeRecording(this.invokeFn, this);
          throw error;
        },
      );
    };
    const fail = (error: unknown) => {
      if (!admissionDispatched) {
        releaseLocalNativeRecording(this.invokeFn, this);
      }
      rejectStart(error);
    };
    try {
      const operation = pending.size
        ? Promise.all([...pending].map((lease) => lease.releasePending())).then(
            admission,
          )
        : admission();
      void operation.then(resolveStart, fail);
    } catch (error) {
      fail(error);
    }
    return this.startPromise;
  }

  /** Ask native for this lease's admission token. A synchronous transport
   * failure cannot have dispatched a start, so the local reservation is
   * released here. */
  private requestAdmission(): Promise<unknown> {
    try {
      return this.invokeFn("recording_generation", {
        ownerId: this.ownerId,
      });
    } catch (error) {
      releaseLocalNativeRecording(this.invokeFn, this);
      return Promise.reject(error);
    }
  }

  /**
   * Dispatch the admitted start and read its reply. Any failure keeps the
   * scoped discard reachable, except while a stop owns the audio.
   */
  private async dispatchStart(
    generation: number,
    preferredMicrophone: string | null,
    waitForRelease: boolean,
    onDispatched?: () => void,
  ): Promise<{ sampleRate: number }> {
    try {
      const request = this.invokeFn("start_recording", {
        ownerId: this.ownerId,
        generation,
        args: {
          preferredMicrophone,
          ...(waitForRelease ? { waitForRelease: true } : {}),
        },
      });
      try {
        onDispatched?.();
      } catch (error) {
        // The IPC is already in flight even if the notification fails.
        // Observe its eventual rejection while the owned cleanup runs.
        void request.catch(() => undefined);
        throw error;
      }
      const sampleRate = sampleRateFromStartResponse(await request);
      this.confirmedSampleRate = sampleRate;
      return { sampleRate };
    } catch (error) {
      // A stop in flight owns the audio. Do not race it with a discard
      // when a lost start reply does not prove whether capture opened.
      if (!this.stopPromise && !this.failedNormalStop) this.queueDiscard();
      throw error;
    }
  }

  stop(): Promise<StopRecordingResponse> {
    if (this.stopPromise) return this.stopPromise;
    if (this.cancelled) {
      return Promise.resolve({ samples: new Float32Array(), sampleRate: 0 });
    }
    if (this.recoveryExpired) {
      return Promise.reject(new Error("Recording recovery expired"));
    }
    if (this.recoveredStop) {
      const recovered = this.takeRecoveredStop();
      if (!recovered)
        return Promise.reject(new Error("Recording recovery expired"));
      this.failedNormalStop = false;
      this.stopPromise = Promise.resolve(recovered);
      this.acknowledge();
      return this.stopPromise;
    }
    this.stopped = true;
    const started = this.startPromise;
    if (!started) {
      return Promise.resolve({ samples: new Float32Array(), sampleRate: 0 });
    }
    if (this.admissionToken === null) {
      // No microphone command can have been sent yet. A lost reservation
      // response must not leave an early stop waiting forever; a late token is
      // discarded by the admission continuation instead.
      releaseLocalNativeRecording(this.invokeFn, this);
      this.stopPromise = Promise.resolve({
        samples: new Float32Array(),
        sampleRate: 0,
      });
      return this.stopPromise;
    }
    // Native serializes stop with opening. Install the shared promise before
    // dispatch so a synchronous transport callback cannot send a second stop.
    let resolveStop!: (result: StopRecordingResponse) => void;
    let rejectStop!: (error: unknown) => void;
    const stopPromise = new Promise<StopRecordingResponse>(
      (resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      },
    );
    this.stopPromise = stopPromise;
    const operation = this.recoveryPromise
      ? this.recoveryPromise.then(() => {
          const recovered = this.takeRecoveredStop();
          if (!recovered) throw new Error("Recording recovery failed");
          return recovered;
        })
      : this.dispatchStopWithRetry(this.admissionToken);
    void operation.then(
      (result) => {
        if (this.cancelled) {
          rejectStop(new Error("Recording was cancelled"));
          return;
        }
        this.released = true;
        this.releaseConfirmed = !result.captureFailed;
        this.failedNormalStop = false;
        releasesFor(this.invokeFn).delete(this);
        releaseLocalNativeRecording(this.invokeFn, this);
        this.acknowledge();
        resolveStop(result);
      },
      (error: unknown) => {
        this.stopPromise = null;
        if (!this.cancelled) {
          this.failedNormalStop = true;
          this.queueRecovery();
        }
        rejectStop(error);
      },
    );
    return stopPromise;
  }

  /** True while this lease may still deliver the audio of a failed stop.
   * A caller polling `waitForStopRecovery` uses this to stop waiting once the
   * retained copy expired or the lease was cancelled, instead of looping on a
   * state that can no longer produce audio. */
  get canRecoverStop(): boolean {
    if (this.cancelled || !this.failedNormalStop) return false;
    return this.recoveredStop !== null || !this.recoveryExpired;
  }

  /** Give an already-running failed-stop recovery a bounded chance to finish.
   * A timeout or retired owner never consumes or acknowledges a late result. */
  async waitForStopRecovery(
    timeoutMs: number,
    isCurrent: () => boolean,
  ): Promise<StopRecordingResponse | null> {
    if (!this.canRecoverStop || this.recoveryExpired || !isCurrent())
      return null;
    // A previous recovery request may have failed before this waiter arrived.
    // Retry the same admission rather than silently abandoning its audio.
    const pending = this.recoveredStop
      ? null
      : (this.recoveryPromise ?? this.recoverPendingStop());
    if (pending && !(await settlesWithin(pending, timeoutMs))) return null;
    if (this.cancelled || !isCurrent() || !this.recoveredStop) return null;
    return this.stop();
  }

  private dispatchStopWithRetry(
    generation: number,
  ): Promise<StopRecordingResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let attempts = 0;
      let pending = 0;
      let firstError: unknown;
      let hasError = false;
      const settle = (
        result: { value: StopRecordingResponse } | { error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(retryTimer);
        if (this.cancelStop === cancel) this.cancelStop = null;
        if ("value" in result) resolve(result.value);
        else reject(result.error);
      };
      const cancel = () =>
        settle({ error: new Error("Recording was cancelled") });
      const attempt = () => {
        if (settled || attempts >= 2) return;
        attempts += 1;
        pending += 1;
        let request: Promise<unknown>;
        try {
          request = this.invokeFn("stop_recording", {
            ownerId: this.ownerId,
            generation,
          });
        } catch (error) {
          request = Promise.reject(error);
        }
        void request.then((payload) => {
          if (settled) return;
          try {
            const decoded = tryDecodeStopRecordingPayload(payload);
            if (!isValidStopResponse(decoded, this.confirmedSampleRate))
              throw new Error("Invalid recording stop response");
            settle({ value: decoded });
          } catch (error) {
            failed(error);
          }
        }, failed);
      };
      const failed = (error: unknown) => {
        if (settled) return;
        pending -= 1;
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
        if (attempts < 2) attempt();
        else if (pending === 0) settle({ error: firstError });
      };
      const retryTimer = setTimeout(attempt, STOP_RETRY_DELAY_MS);
      this.cancelStop = cancel;
      attempt();
    });
  }

  private acknowledge(): void {
    // Acknowledgement removes only the recovery copy. It does not stop a
    // recorder and does not delay delivery if IPC is unavailable.
    try {
      void this.invokeFn("acknowledge_recording", {
        ownerId: this.ownerId,
        generation: this.admissionToken,
      }).catch(() => undefined);
    } catch {
      // Native also expires unacknowledged copies.
    }
  }

  /** Cancel a capture without waiting for a pending start or retaining audio. */
  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    if (this.released) {
      if (this.failedNormalStop) {
        this.cancelled = true;
        this.takeRecoveredStop();
      }
      this.acknowledge();
      if (this.releaseConfirmed) return Promise.resolve();
      // A sealed failed capture may have been handed off while the driver is
      // still releasing. Ask native about this exact admission instead of
      // treating the audio response as proof that the microphone is free.
    }
    this.cancelled = true;
    this.stopped = true;
    this.cancelStop?.();
    if (!this.startPromise) return Promise.resolve();
    if (this.admissionToken === null) {
      // No start can be sent until the reservation reply supplies its token.
      // The late reply observes `stopped` and discards that exact admission.
      releaseLocalNativeRecording(this.invokeFn, this);
      return Promise.resolve();
    }
    releasesFor(this.invokeFn).add(this);
    this.cancelPromise = this.discard().catch((error: unknown) => {
      this.cancelPromise = null;
      throw error;
    });
    return this.cancelPromise;
  }

  private releaseUnusedAdmission(): void {
    this.stopped = true;
    releaseLocalNativeRecording(this.invokeFn, this);
    // No start command was sent, so a lost discard reply cannot conceal an
    // open microphone or require blocking a successor.
    void this.discard().catch(() => undefined);
  }

  private queueDiscard(): void {
    releasesFor(this.invokeFn).add(this);
    void this.discard().catch(() => undefined);
  }

  private queueRecovery(): void {
    releasesFor(this.invokeFn).add(this);
    // A rejected stop response may conceal a sealed recording. Retrying the
    // scoped normal stop both releases a live owner and preserves its audio;
    // a discard here would irreversibly delete a valid recovery copy.
    void this.recoverPendingStop().catch(() => undefined);
  }

  private takeRecoveredStop(): StopRecordingResponse | null {
    const recovered = this.recoveredStop;
    const expired = recovered !== null && Date.now() >= this.recoveryDeadline;
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveredStop = null;
    if (recovered) {
      recoveredStopCount -= 1;
      recoveredStopBytes -= this.retainedBytes;
      this.retainedBytes = 0;
    }
    if (expired) {
      this.recoveryExpired = true;
      return null;
    }
    return recovered;
  }

  private recoverPendingStop(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.recoveredStop) return Promise.resolve();
    const generation = this.admissionToken;
    if (generation === null)
      return Promise.reject(new Error("Missing recording admission"));
    // Install the shared recovery before invoking transport: transport hooks
    // may synchronously reenter stop() or start a successor.
    let resolveRecovery!: () => void;
    let rejectRecovery!: (error: unknown) => void;
    const shared = new Promise<void>((resolve, reject) => {
      resolveRecovery = resolve;
      rejectRecovery = reject;
    });
    this.recoveryPromise = shared;
    const finish = (error?: { value: unknown }) => {
      if (this.recoveryPromise === shared) this.recoveryPromise = null;
      if (error) rejectRecovery(error.value);
      else resolveRecovery();
    };
    try {
      void this.dispatchStopWithRetry(generation).then(
        (result) => {
          try {
            if (this.cancelled) {
              finish({ value: new Error("Recording was cancelled") });
              return;
            }
            // Keep the result available to an explicit stop retry, with a
            // process-wide bound in addition to native's own replay budget.
            const bytes =
              result.samples instanceof Float32Array
                ? result.samples.buffer.byteLength
                : result.samples.length * 8;
            if (
              recoveredStopCount >= MAX_RECOVERED_STOPS ||
              bytes > MAX_RECOVERED_STOP_BYTES - recoveredStopBytes
            ) {
              finish({ value: new Error("Recording recovery buffer is full") });
              return;
            }
            recoveredStopCount += 1;
            recoveredStopBytes += bytes;
            this.retainedBytes = bytes;
            this.recoveredStop = result;
            // Invariant: a retained copy is always deliverable, so an earlier
            // expiry latch must not keep hiding audio that a later retry
            // managed to recover.
            this.recoveryExpired = false;
            this.recoveryDeadline = Date.now() + RECOVERED_STOP_LIFETIME_MS;
            this.recoveryTimer = setTimeout(() => {
              this.takeRecoveredStop();
              this.recoveryExpired = true;
            }, RECOVERED_STOP_LIFETIME_MS);
            this.released = true;
            this.releaseConfirmed = !result.captureFailed;
            releasesFor(this.invokeFn).delete(this);
            releaseLocalNativeRecording(this.invokeFn, this);
            finish();
          } catch (error) {
            this.takeRecoveredStop();
            finish({ value: error });
          }
        },
        (error: unknown) => finish({ value: error }),
      );
    } catch (error) {
      finish({ value: error });
    }
    return shared;
  }

  private releasePending(): Promise<void> {
    return this.failedNormalStop && !this.cancelled
      ? this.recoverPendingStop()
      : this.discard();
  }

  private discard(): Promise<void> {
    if (this.discardPromise) return this.discardPromise;
    const generation = this.admissionToken;
    if (generation === null) return Promise.resolve();
    this.discardPromise = Promise.resolve()
      .then(() =>
        this.invokeFn("discard_recording", {
          ownerId: this.ownerId,
          generation,
        }),
      )
      .then(() => {
        this.releaseConfirmed = true;
        releasesFor(this.invokeFn).delete(this);
        releaseLocalNativeRecording(this.invokeFn, this);
      })
      .finally(() => {
        this.discardPromise = null;
      });
    return this.discardPromise;
  }

  async ensureReleasedAfterFailure(): Promise<void> {
    // A caller using this method is abandoning the failed operation (for
    // example, before starting browser fallback), so explicit discard is
    // appropriate even if a normal-stop recovery is in progress.
    if (this.failedNormalStop) {
      await this.cancel();
    } else if (releasesFor(this.invokeFn).has(this)) {
      await this.discard();
    }
  }

  async pause(): Promise<void> {
    await this.control("pause_recording");
  }

  async resume(): Promise<void> {
    await this.control("resume_recording");
  }

  private async control(command: string): Promise<void> {
    if (!this.startPromise || this.stopped) {
      throw new Error("Recording lease is closed");
    }
    await this.startPromise;
    if (this.stopped) throw new Error("Recording lease is closed");
    if (this.admissionToken === null)
      throw new Error("Missing recording admission");
    await this.invokeFn(command, {
      ownerId: this.ownerId,
      generation: this.admissionToken,
    });
  }
}

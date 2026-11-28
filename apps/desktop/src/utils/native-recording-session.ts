import { invoke } from "@tauri-apps/api/core";
import type { StopRecordingResponse } from "../types/transcription-session.types";
import { createId } from "./id.utils";
import { getLogger } from "./log.utils";
import {
  acquireLocalNativeRecording,
  releaseLocalNativeRecording,
} from "./local-recording-activity";
import { decodeStopRecordingPayload } from "./recorded-audio.utils";
import { withTimeout } from "./timeout.utils";

/** A previous admission has not confirmed release; no new provider was tried. */
export class PendingRecordingReleaseError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

// Match the native start command's two-second release wait. Only the waiter
// expires; the owned command and local slot survive until native confirms.
export const waitForRecordingRelease = async (
  pending: Promise<unknown>,
): Promise<void> => {
  try {
    await withTimeout(pending, 2_000, "Recording release");
  } catch (cause) {
    throw new PendingRecordingReleaseError(cause);
  }
};

// Enough for a transient transport rejection to clear. Native owns the longer
// recovery, so this cap only has to outlast a momentary IPC failure.
const PARTIAL_RELEASE_ATTEMPTS = 3;

// `start_recording` returns Result<_, String>; Tauri rejects with this exact
// string when the owner is in another webview and not in our local session.
const RECORDING_BUSY = "A recording is already in progress";

export class ActiveRecordingError extends Error {
  constructor(message = RECORDING_BUSY) {
    super(message);
  }
}

export type RecordingInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * One recording the native recorder has admitted.
 *
 * Native scopes commands to the window and the `(ownerId, generation)` it
 * admitted. A late stop can never name the successor through this handle;
 * discarding an already released admission is a no-op.
 */
export type NativeRecordingHandle = {
  readonly ownerId: string;
  readonly generation: number;
  /** Stop the recorder and return its audio. */
  stop: () => Promise<StopRecordingResponse>;
  /** Stop the recorder and throw its audio away. */
  discard: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** True while available for live controls, not during stop or discard. */
  isLive: () => boolean;
};

export type NativeRecordingStartOptions = {
  waitForRelease?: boolean;
  /**
   * Independent callers retain their admission and use only that handle for
   * cleanup. They do not supersede live audio and can yield the start gate on
   * confirmed release. Legacy callers may still clean up globally on return.
   */
  handleScoped?: boolean;
  /** Called after reserving an owner, before capture can emit its first chunk. */
  onAdmission?: (handle: NativeRecordingHandle) => void;
};

// The generation is a `u64` on the Rust side; `Number.MAX_SAFE_INTEGER` is the
// largest value a JS number carries exactly.
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;

const EMPTY_RESULT = (): StopRecordingResponse => ({
  samples: new Float32Array(0),
  sampleRate: 0,
});

// Keep the admission until a terminal command succeeds. A rejected IPC reply
// cannot tell us that the device (or the local browser/native slot) is free.
let session: RecordingSession | null = null;
type StartOwner = { handleScoped: boolean };
let openingOwner: StartOwner | null = null;

// A confirmed release can precede the old start reply. Neither that late
// reply nor cleanup for the previous session may unlock its successor.
const finishOpening = (owner: StartOwner): void => {
  if (openingOwner === owner) openingOwner = null;
};

/** The recorder available for live controls, not one already being stopped. */
export const currentNativeRecording = (): NativeRecordingHandle | null =>
  session?.isLive() ? session : null;

/** Test seam: forget the tracked recording without touching native. */
export const resetNativeRecordingSession = (): void => {
  session = null;
};

export const isSafeGeneration = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= MAX_SAFE_GENERATION;

const sampleRateFromStartResponse = (result: unknown): number => {
  if (!result || typeof result !== "object" || !("sampleRate" in result)) {
    throw new Error("Invalid recording start response");
  }
  const { sampleRate } = result as { sampleRate: unknown };
  if (!isSafeGeneration(sampleRate) || sampleRate === 0) {
    throw new Error("Invalid recording start response");
  }
  return sampleRate;
};

/** The two ways to end *this admission*: keep its audio, or abandon it. */
class RecordingSession implements NativeRecordingHandle {
  private stopping: Promise<StopRecordingResponse> | null = null;
  private discarding: Promise<void> | null = null;
  discardRequested = false;

  constructor(
    readonly ownerId: string,
    readonly generation: number,
    private readonly transport: RecordingInvoke,
    private readonly localOwner: StartOwner,
  ) {}

  isLive(): boolean {
    return session === this && !this.stopping && !this.discardRequested;
  }

  canRetryOpeningDiscard(owner: StartOwner | null): boolean {
    return (
      this.localOwner === owner &&
      owner.handleScoped &&
      this.discardRequested &&
      !this.discarding
    );
  }

  private async command(name: string, transport = this.transport) {
    return transport(name, {
      ownerId: this.ownerId,
      generation: this.generation,
    });
  }

  private async liveCommand(
    name: "pause_recording" | "resume_recording",
  ): Promise<void> {
    if (!this.isLive()) throw new Error("No native recording is active");
    await this.command(name);
  }

  pause(): Promise<void> {
    return this.liveCommand("pause_recording");
  }

  resume(): Promise<void> {
    return this.liveCommand("resume_recording");
  }

  private released(): void {
    releaseLocalNativeRecording(this.transport, this.localOwner);
    if (this.localOwner.handleScoped) finishOpening(this.localOwner);
    if (session === this) session = null;
  }

  private async stopAndRead(
    transport: RecordingInvoke,
  ): Promise<StopRecordingResponse> {
    const payload = await this.command("stop_recording", transport);
    const audio = decodeStopRecordingPayload(payload);
    // Native may seal partial audio *before* it releases the device. Deliver
    // the samples now, but only a scoped discard can confirm that terminal state.
    if (audio.captureFailed) this.confirmPartialRelease();
    else this.released();
    // An ack only retires native's recovery copy. A lost ack cannot reopen
    // capture and a stalled one must not block the next start.
    void this.command("acknowledge_recording", transport).catch(() => {
      getLogger().verbose("acknowledge_recording failed");
    });
    return audio;
  }

  private confirmPartialRelease(attempt = 0): void {
    // Retry just this tuple; discard is idempotent and a no-op after retirement.
    // A concurrent waiter joins the same command rather than opening the gate.
    //
    // Bounded, because native already runs its own release retry for this
    // admission. This loop only covers a rejected round trip, so a device that
    // never releases would otherwise keep a timer alive for the life of the
    // page. After the last attempt the session keeps the sealed audio it already
    // delivered and the local slot stays held, which the next start reports as a
    // pending release rather than silently reopening capture.
    void this.discard().catch((cause) => {
      if (attempt + 1 >= PARTIAL_RELEASE_ATTEMPTS) {
        getLogger().warning(
          `Partial capture release failed after ${PARTIAL_RELEASE_ATTEMPTS} attempts`,
          cause,
        );
        return;
      }
      setTimeout(() => this.confirmPartialRelease(attempt + 1), 1_000);
    });
  }

  stop(transport = this.transport): Promise<StopRecordingResponse> {
    if (session !== this) {
      return Promise.reject(
        new Error("Recording is no longer owned by this session"),
      );
    }
    if (this.discardRequested)
      return waitForRecordingRelease(this.discard()).then(EMPTY_RESULT);
    // Publish before invoking the transport. Global and owned callers join
    // the same stop, even when the transport fails synchronously.
    this.stopping ??= Promise.resolve()
      .then(() => this.stopAndRead(transport))
      .finally(() => {
        this.stopping = null;
      });
    return this.stopping;
  }

  discard(): Promise<void> {
    if (session !== this) return Promise.resolve();
    this.discardRequested = true;
    this.discarding ??= this.discardAfterStop().finally(() => {
      this.discarding = null;
    });
    return this.discarding;
  }

  private async discardAfterStop(): Promise<void> {
    if (this.stopping) {
      try {
        await this.stopping;
        if (session !== this) return; // A clean stop confirmed release.
      } catch {
        // A failed stop leaves only this admission to discard.
      }
    }
    await this.command("discard_recording");
    this.released();
  }

  async releaseForReplacement(preserveLiveRecording = false): Promise<void> {
    if (preserveLiveRecording && this.isLive())
      throw new ActiveRecordingError();
    // Do not hide a failed stop from a start that was waiting for it. The
    // next attempt can retry release using the same owner and generation.
    await waitForRecordingRelease(this.completeRelease());
  }

  private async completeRelease(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (session === this) await this.discard();
  }
}

/** A browser-only retry may finish an abandoned release, never a live capture. */
export const finishAbandonedNativeDiscard = (): Promise<void> | undefined =>
  session?.discardRequested
    ? waitForRecordingRelease(session.discard())
    : undefined;

/**
 * Open the microphone under a fresh native admission.
 *
 * A recording left live by a superseded start is discarded first: native admits
 * one owner at a time, and inheriting the old stream is the bug the admission
 * exists to prevent.
 */
export const beginNativeRecording = async (
  preferredMicrophone: string | null,
  options: NativeRecordingStartOptions = {},
  invokeFn: RecordingInvoke = invoke,
): Promise<{ sampleRate: number; handle: NativeRecordingHandle }> => {
  // Only the abandoned opening itself can yield. A replacement may already
  // be opening while it waits for a *different* admission to release.
  const abandoned = session?.canRetryOpeningDiscard(openingOwner)
    ? session
    : null;
  if (abandoned) await waitForRecordingRelease(abandoned.discard());
  // Do not supersede a successor that opened while this retry was waiting.
  if (openingOwner || (abandoned && session))
    throw new ActiveRecordingError("A recording start is already in progress");
  const localOwner = { handleScoped: options.handleScoped === true };
  openingOwner = localOwner;
  try {
    return await beginNativeRecordingOwned(
      preferredMicrophone,
      options,
      invokeFn,
      localOwner,
    );
  } finally {
    finishOpening(localOwner);
  }
};

const beginNativeRecordingOwned = async (
  preferredMicrophone: string | null,
  options: NativeRecordingStartOptions,
  invokeFn: RecordingInvoke,
  localOwner: StartOwner,
): Promise<{ sampleRate: number; handle: NativeRecordingHandle }> => {
  if (session) await session.releaseForReplacement(localOwner.handleScoped);

  // The browser recognizer holds the same in-webview slot, so a dictation
  // started while it listens is refused here instead of opening a second
  // capture beside it.
  const ownerId = createId();
  if (!acquireLocalNativeRecording(invokeFn, localOwner)) {
    throw new ActiveRecordingError();
  }
  let generation: number;
  try {
    const reserved = await invokeFn("recording_generation", { ownerId });
    if (!isSafeGeneration(reserved))
      throw new Error("Invalid recording generation");
    generation = reserved;
  } catch (error) {
    releaseLocalNativeRecording(invokeFn, localOwner);
    throw error;
  }

  const handle = new RecordingSession(
    ownerId,
    generation,
    invokeFn,
    localOwner,
  );
  session = handle;
  try {
    options.onAdmission?.(handle);
    const response = await invokeFn("start_recording", {
      ownerId,
      generation,
      args: {
        preferredMicrophone,
        ...(options.waitForRelease ? { waitForRelease: true } : {}),
      },
    });
    return { sampleRate: sampleRateFromStartResponse(response), handle };
  } catch (error) {
    // The start may have opened the device before it failed; a discard is the
    // only call that proves the recorder is released again.
    await waitForRecordingRelease(handle.discard());
    if (error === RECORDING_BUSY) throw new ActiveRecordingError();
    throw error;
  }
};

/**
 * Stop the recording a surface admitted, releasing the device when the stop is
 * rejected.
 *
 * A rejected stop can leave the capture open, and the handle is the only
 * reference to it, so dropping it would hold the microphone for the rest of the
 * session. The original error still reaches the caller.
 */
export const stopAdmittedRecording = async (
  handle: NativeRecordingHandle | null,
): Promise<StopRecordingResponse> => {
  if (!handle) return EMPTY_RESULT();
  try {
    return await handle.stop();
  } catch (error) {
    void handle.discard().catch((cause) => {
      getLogger().warning(
        "Failed to release a capture after a failed stop",
        cause,
      );
    });
    throw error;
  }
};

/** Stop this webview's current recording when the caller has no handle. */
export const stopNativeRecording = (
  invokeFn?: RecordingInvoke,
): Promise<StopRecordingResponse> =>
  session?.stop(invokeFn) ?? Promise.resolve(EMPTY_RESULT());

/** Destructive cleanup needs device release, not just a sealed audio reply. */
export const stopNativeRecordingForTeardown = async (): Promise<void> => {
  const owned = session;
  if (!owned) return;
  if (!owned.discardRequested) {
    try {
      if (!(await owned.stop()).captureFailed) return;
    } catch (stopError) {
      // A failed capture can reject every subsequent stop on this tuple.
      // Discard it before reporting the failure; retain it if discard fails.
      try {
        await waitForRecordingRelease(owned.discard());
      } catch {
        getLogger().verbose(
          "Recording discard unconfirmed after teardown stop failed",
        );
        throw stopError;
      }
      // Destructive cleanup needs release, not the audio that stop could not
      // return. Record the recovered failure without logging native payloads.
      getLogger().warning("Recording stop failed; teardown confirmed discard");
      return;
    }
  }
  await waitForRecordingRelease(owned.discard());
};

/** Best-effort teardown. A failed discard remains addressable for retry. */
export const discardNativeRecording = async (): Promise<void> => {
  await session?.discard().catch(() => {
    getLogger().verbose("discard_recording failed");
  });
};

/**
 * Stop the live recording and decode its reply, or, when a caller injects its
 * own transport (tests, preview), just decode what that transport returned.
 */
export const invokeStopRecording = async (
  invokeFn?: RecordingInvoke,
): Promise<StopRecordingResponse> =>
  invokeFn
    ? decodeStopRecordingPayload(await invokeFn("stop_recording"))
    : stopNativeRecording();

const controlLive = async (invokeFn: RecordingInvoke, command: string) => {
  const handle = currentNativeRecording();
  if (!handle) {
    throw new Error("No native recording is active");
  }
  await invokeFn(command, {
    ownerId: handle.ownerId,
    generation: handle.generation,
  });
};

export const pauseNativeRecording = (
  invokeFn: RecordingInvoke = invoke,
): Promise<void> => controlLive(invokeFn, "pause_recording");

export const resumeNativeRecording = (
  invokeFn: RecordingInvoke = invoke,
): Promise<void> => controlLive(invokeFn, "resume_recording");

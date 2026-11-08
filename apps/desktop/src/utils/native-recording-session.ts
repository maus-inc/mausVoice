import { invoke } from "@tauri-apps/api/core";
import type { StopRecordingResponse } from "../types/transcription-session.types";
import { createId } from "./id.utils";
import { getLogger } from "./log.utils";
import {
  acquireLocalNativeRecording,
  releaseLocalNativeRecording,
} from "./local-recording-activity";
import { decodeStopRecordingPayload } from "./recorded-audio.utils";

export type RecordingInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * One recording the native recorder has admitted.
 *
 * Native hands out a `(ownerId, generation)` admission and refuses every
 * command that touches the recorder unless it presents that same pair. Holding
 * the pair on the handle means a component that stops late — after an abort, a
 * restart, or an unmount — can only ever address the stream it opened: native
 * answers a stale pair with a mismatch instead of cutting a newer recording's
 * stream.
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
  /** Whether this handle is still the one the recorder is owned by. */
  isLive: () => boolean;
};

export type NativeRecordingStartOptions = {
  waitForRelease?: boolean;
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

/** The recorder this module owns, if a recording is live. */
let liveHandle: NativeRecordingHandle | null = null;

/** The in-webview slot token and transport that live handle holds, if any. */
let liveLocalOwner: { owner: object; transport: RecordingInvoke } | null = null;

let beginInFlight = false;

/** The recorder this module currently owns, if any. */
export const currentNativeRecording = (): NativeRecordingHandle | null =>
  liveHandle;

/** Test seam: forget the tracked recording without touching native. */
export const resetNativeRecordingSession = (): void => {
  liveHandle = null;
  liveLocalOwner = null;
};

const isSafeGeneration = (value: unknown): value is number =>
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
  if (beginInFlight)
    throw new Error("A recording start is already in progress");
  beginInFlight = true;
  try {
    return await beginNativeRecordingOwned(
      preferredMicrophone,
      options,
      invokeFn,
    );
  } finally {
    beginInFlight = false;
  }
};

const beginNativeRecordingOwned = async (
  preferredMicrophone: string | null,
  options: NativeRecordingStartOptions,
  invokeFn: RecordingInvoke,
): Promise<{ sampleRate: number; handle: NativeRecordingHandle }> => {
  const superseded = liveHandle;
  if (superseded) {
    await superseded.discard().catch((error: unknown) => {
      getLogger().warning(`Failed to discard a superseded recording: ${error}`);
    });
  }

  // The browser recognizer holds the same in-webview slot, so a dictation
  // started while it listens is refused here instead of opening a second
  // capture beside it.
  const localOwner = {};
  if (!acquireLocalNativeRecording(invokeFn, localOwner)) {
    throw new Error("A recording is already in progress");
  }
  const releaseLocal = () => {
    releaseLocalNativeRecording(invokeFn, localOwner);
    if (liveLocalOwner?.owner === localOwner) liveLocalOwner = null;
  };
  const ownerId = createId();
  let reserved: unknown;
  try {
    reserved = await invokeFn("recording_generation", { ownerId });
  } catch (error) {
    releaseLocal();
    throw error;
  }
  if (!isSafeGeneration(reserved)) {
    releaseLocal();
    throw new Error("Invalid recording generation");
  }

  let settled = false;
  const handle: NativeRecordingHandle = {
    ownerId,
    generation: reserved,
    isLive: () => liveHandle === handle && !settled,
    stop: async () => {
      const payload = await invokeFn("stop_recording", {
        ownerId,
        generation: reserved,
      });
      settled = true;
      if (liveHandle === handle) liveHandle = null;
      const decoded = decodeStopRecordingPayload(payload);
      // Acknowledging only drops the recovery copy native kept for a lost
      // reply; it never stops the recorder, so a failure here costs a retained
      // buffer, not audio.
      await invokeFn("acknowledge_recording", {
        ownerId,
        generation: reserved,
      }).catch((error: unknown) => {
        getLogger().verbose(`acknowledge_recording failed: ${error}`);
      });
      releaseLocal();
      return decoded;
    },
    discard: async () => {
      settled = true;
      if (liveHandle === handle) liveHandle = null;
      try {
        await invokeFn("discard_recording", { ownerId, generation: reserved });
      } finally {
        // Native answers a refused discard with a mismatch, so the slot is
        // released here even when the call failed: a stale handle is exactly
        // what a browser-recognition start must not be blocked by.
        releaseLocal();
      }
    },
    pause: async () => {
      await invokeFn("pause_recording", { ownerId, generation: reserved });
    },
    resume: async () => {
      await invokeFn("resume_recording", { ownerId, generation: reserved });
    },
  };

  liveHandle = handle;
  liveLocalOwner = { owner: localOwner, transport: invokeFn };
  try {
    options.onAdmission?.(handle);
    const response = await invokeFn("start_recording", {
      ownerId,
      generation: reserved,
      args: {
        preferredMicrophone,
        ...(options.waitForRelease ? { waitForRelease: true } : {}),
      },
    });
    return { sampleRate: sampleRateFromStartResponse(response), handle };
  } catch (error) {
    // The start may have opened the device before it failed; a discard is the
    // only call that proves the recorder is released again.
    await handle.discard().catch(() => undefined);
    releaseLocal();
    throw error;
  }
};

/**
 * Stop the live recording and return its audio.
 *
 * These are the teardown paths that have no handle in scope (a clear request,
 * an unmount, a settings action). They deliberately address whatever recording
 * is live rather than a specific owner.
 */
export const stopNativeRecording = async (
  invokeFn: RecordingInvoke = invoke,
): Promise<StopRecordingResponse> => {
  const handle = liveHandle;
  if (!handle) return EMPTY_RESULT();
  const localOwner = liveLocalOwner;
  liveHandle = null;
  try {
    const payload = await invokeFn("stop_recording", {
      ownerId: handle.ownerId,
      generation: handle.generation,
    });
    const decoded = decodeStopRecordingPayload(payload);
    await invokeFn("acknowledge_recording", {
      ownerId: handle.ownerId,
      generation: handle.generation,
    }).catch((error: unknown) => {
      getLogger().verbose(`acknowledge_recording failed: ${error}`);
    });
    if (localOwner) {
      releaseLocalNativeRecording(localOwner.transport, localOwner.owner);
      if (liveLocalOwner === localOwner) liveLocalOwner = null;
    }
    return decoded;
  } catch (error) {
    // Keep the handle addressable so a retry can still release the recorder.
    liveHandle = liveHandle ?? handle;
    throw error;
  }
};

/** Stop the live recording and throw its audio away. */
export const discardNativeRecording = async (): Promise<void> => {
  const handle = liveHandle;
  if (!handle) return;
  liveHandle = null;
  await handle.discard().catch((error: unknown) => {
    getLogger().verbose(`discard_recording failed: ${error}`);
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
  const handle = liveHandle;
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

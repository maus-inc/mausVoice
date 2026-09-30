import { invoke } from "@tauri-apps/api/core";
import { getLogger } from "../../utils/log.utils";

/**
 * Owns the system-volume dim that runs for the length of a dictation.
 *
 * The dim is two IPC round trips, so it is started fire and forget from
 * `startRecording`: the activation controller serialises activate before
 * deactivate, and awaiting the round trips there would put them in front of the
 * stop the user's key release triggers and keep the microphone open past the
 * release. Nothing here may therefore be ordered by awaiting, and a dim has to
 * be able to tell on its own whether the recording it belongs to is still open.
 */
export type SystemVolumeDim = {
  /**
   * Dims the system volume for the recording that owns `operationId`, and puts
   * it back if that recording ends while the dim is in flight.
   */
  dim: (operationId: number) => Promise<void>;
  /**
   * Ends the dim for the recording that is stopping or tearing down. Every stop
   * path calls this before it awaits anything.
   */
  endRecording: () => void;
};

export const createSystemVolumeDim = (args: {
  /** Volume read before the dim, or null while no dim is outstanding. */
  preDimVolumeRef: { current: number | null };
  getDimLevel: () => number;
}): SystemVolumeDim => {
  /**
   * Bumped by every end of a recording. A dim captures it when it starts and
   * re-reads it after each await, so a stop that lands mid-dim retires that dim.
   *
   * The recording operation token cannot serve this purpose. It is deliberately
   * left alone until transcription has finished, because the interim-segment
   * guard reads it to keep accepting the segments a streaming provider flushes
   * while the stop is still finalizing. Invalidation has to be synchronous and
   * early, so the dim keeps an end marker of its own.
   */
  let recordingGeneration = 0;
  const preDimVolumeRef = args.preDimVolumeRef;
  const setSystemVolume = (volume: number): Promise<void> =>
    invoke<void>("set_system_volume", { volume });

  const endRecording = (): void => {
    // Bumped first, and with no await in between. A stop is not finished when it
    // returns: it waits for transcription before the recording is torn down, and
    // a dim still in flight across this point would otherwise apply after the
    // stop, with nothing left to put it back.
    recordingGeneration += 1;
    const volumeToRestore = preDimVolumeRef.current;
    preDimVolumeRef.current = null;
    if (volumeToRestore !== null) {
      setSystemVolume(volumeToRestore).catch((error) =>
        getLogger().verbose(`Failed to restore system volume: ${error}`),
      );
    }
  };

  const dim = async (operationId: number): Promise<void> => {
    const dimLevel = args.getDimLevel();
    if (dimLevel >= 1.0) return;
    const generation = recordingGeneration;

    try {
      const volumeBeforeDim = await invoke<number>("get_system_volume");
      // A stop can land while this read is in flight. The volume to restore is
      // only known once it returns, so a stop in that window has nothing to put
      // back and the dim would then apply with no restore ever following it,
      // leaving system audio dimmed for the rest of the session.
      if (generation !== recordingGeneration) {
        getLogger().verbose(
          `Skipping volume dim: recording ${operationId} ended before it applied`,
        );
        return;
      }
      preDimVolumeRef.current = volumeBeforeDim;
      await setSystemVolume(volumeBeforeDim * dimLevel);
      // And a stop that lands while the write is in flight is honoured here, for
      // the same reason: the dim has now taken effect and nothing else will take
      // it back.
      if (generation === recordingGeneration) return;
      // The end that retired this dim already spent the shared ref, so writing
      // back through it would find nothing to restore. This dim writes back the
      // exact volume it displaced instead, but only while the ref is unclaimed:
      // a recording that has already started its own dim owns it now, and
      // writing here would un-dim that recording and leave it unrestored.
      if (preDimVolumeRef.current !== null) return;
      await setSystemVolume(volumeBeforeDim);
    } catch (error) {
      getLogger().verbose(`Failed to dim system volume: ${error}`);
    }
  };

  return { dim, endRecording };
};

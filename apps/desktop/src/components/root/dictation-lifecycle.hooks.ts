import { useCallback, useEffect, useMemo } from "react";
import { getAppState, produceAppState } from "../../store";
import { useDictationLifecycleRefs } from "./dictation-lifecycle-refs.hooks";
import {
  releaseRecordingResources,
  takeRecordingResources,
} from "./dictation-recording-intake";
import { createSystemVolumeDim } from "./dictation-volume-dim";
import { releaseRecordingResource } from "./dictation-cleanup";

/** Own recording state, system-volume restoration and unmount teardown. */
export function useDictationLifecycle() {
  const refs = useDictationLifecycleRefs();
  const {
    preDictationVolumeRef,
    recordingOperationRef,
    nativeStartOwnerRef,
    audioChunkUnlistenRef,
    sessionRef,
    strategyRef,
    utteranceTonesRef,
    isPausedRef,
  } = refs;
  const systemVolumeDim = useMemo(
    () =>
      createSystemVolumeDim({
        preDimVolumeRef: preDictationVolumeRef,
        getDimLevel: () => getAppState().userPrefs?.dictationAudioDim ?? 1.0,
      }),
    [preDictationVolumeRef],
  );
  useEffect(
    () => () => {
      const operation = ++recordingOperationRef.current;
      const owned = takeRecordingResources({
        audioChunkUnlistenRef,
        sessionRef,
        strategyRef,
        nativeStartOwnerRef,
      });
      releaseRecordingResource("System volume", "during unmount", () =>
        systemVolumeDim.endRecording(),
      );
      releaseRecordingResources({
        ...owned,
        isCurrent: () => recordingOperationRef.current === operation,
      });
    },
    [
      systemVolumeDim,
      recordingOperationRef,
      nativeStartOwnerRef,
      audioChunkUnlistenRef,
      sessionRef,
      strategyRef,
    ],
  );
  const clearUtteranceToneSnapshots = useCallback(() => {
    utteranceTonesRef.current.clear();
  }, [utteranceTonesRef]);
  const clearRecordingState = useCallback(() => {
    isPausedRef.current = false;
    produceAppState((draft) => {
      draft.activeRecordingMode = null;
      draft.dictationLanguageOverride = null;
      draft.assistantInputMode = "voice";
    });
  }, [isPausedRef]);
  return {
    ...refs,
    systemVolumeDim,
    clearUtteranceToneSnapshots,
    clearRecordingState,
  };
}

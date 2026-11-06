import type { UnlistenFn } from "@tauri-apps/api/event";
import { useRef } from "react";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import { createUtteranceToneSnapshots } from "../../utils/dictation-style.utils";
import type { NativeRecordingLease } from "../../utils/native-recording-lease";
import type { PipelineTrace } from "../../utils/pipeline-trace";

/** Stable, instance-local ownership state for one dictation lifecycle. */
export function useDictationLifecycleRefs() {
  const strategyRef = useRef<BaseStrategy | null>(null);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const audioChunkUnlistenRef = useRef<UnlistenFn | null>(null);
  const recordingOperationRef = useRef(0);
  const recordingSessionRef = useRef<(() => boolean) | null>(null);
  const nativeStartOwnerRef = useRef<NativeRecordingLease | null>(null);
  const preDictationVolumeRef = useRef<number | null>(null);
  const isStoppingRef = useRef(false);
  const isPausedRef = useRef(false);
  const pipelineTraceRef = useRef<PipelineTrace | null>(null);
  const utteranceTonesRef = useRef(createUtteranceToneSnapshots());
  return {
    strategyRef,
    sessionRef,
    audioChunkUnlistenRef,
    recordingOperationRef,
    recordingSessionRef,
    nativeStartOwnerRef,
    preDictationVolumeRef,
    isStoppingRef,
    isPausedRef,
    pipelineTraceRef,
    utteranceTonesRef,
  };
}

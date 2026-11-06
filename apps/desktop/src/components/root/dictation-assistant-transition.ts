import type { UnlistenFn } from "@tauri-apps/api/event";
import { produceAppState } from "../../store";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import { getLogger } from "../../utils/log.utils";
import { releaseRecordingResource } from "./dictation-cleanup";
import {
  stopNativeRecordingForAbort,
  type NativeRecordingLeaseRef,
} from "./dictation-recording-intake";

/** Retire microphone startup and provider ownership while retaining the assistant panel. */
export function enterAssistantTypeMode({
  operationRef,
  nativeStartOwnerRef,
  sessionRef,
  audioChunkUnlistenRef,
  endVolumeDim,
  clearTimers,
  resetHotkeys,
  releaseAudioIntake,
  clearToneSnapshots,
  sendIdle,
}: {
  operationRef: { current: number };
  nativeStartOwnerRef: NativeRecordingLeaseRef;
  sessionRef: { current: TranscriptionSession | null };
  audioChunkUnlistenRef: { current: UnlistenFn | null };
  endVolumeDim: () => void;
  clearTimers: () => void;
  resetHotkeys: () => void;
  releaseAudioIntake: (owned?: UnlistenFn | null) => void;
  clearToneSnapshots: () => void;
  sendIdle: () => Promise<void>;
}): void {
  getLogger().info("Switching to type mode");
  const operation = ++operationRef.current;
  const isCurrent = () => operationRef.current === operation;
  const whileOwned = (action: () => void | Promise<void>) => () => {
    if (isCurrent()) return action();
  };
  const session = sessionRef.current;
  const ownedAudioIntake = audioChunkUnlistenRef.current;
  sessionRef.current = null;
  // Take the native lease before any auxiliary callback can install a successor.
  releaseRecordingResource("Native capture", "during type mode switch", () =>
    stopNativeRecordingForAbort(nativeStartOwnerRef),
  );
  releaseRecordingResource(
    "System volume",
    "during type mode switch",
    whileOwned(endVolumeDim),
  );
  releaseRecordingResource(
    "Recording timers",
    "during type mode switch",
    whileOwned(clearTimers),
  );
  releaseRecordingResource(
    "Hotkeys",
    "during type mode switch",
    whileOwned(resetHotkeys),
  );
  releaseRecordingResource("Audio intake", "during type mode switch", () =>
    releaseAudioIntake(ownedAudioIntake),
  );
  releaseRecordingResource(
    "Idle phase",
    "during type mode switch",
    whileOwned(sendIdle),
  );
  releaseRecordingResource("Session", "during type mode switch", () =>
    session?.cleanup(),
  );
  releaseRecordingResource(
    "Recording style",
    "during type mode switch",
    whileOwned(clearToneSnapshots),
  );
  if (isCurrent()) {
    produceAppState((draft) => {
      draft.assistantInputMode = "type";
    });
  }
}

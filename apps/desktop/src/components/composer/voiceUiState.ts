/**
 * Shared pill + composer recording vocabulary (i18n + tests).
 * Implementation may use provider/browser internally; UI speaks these three.
 */
export type VoiceUiPhase = "idle" | "recording" | "preview";

/** elevenlabs-ui/ui/speech-input.tsx SpeechInputRecordButton aria-label */
export const voiceUiAriaLabel = (phase: VoiceUiPhase): string => {
  if (phase === "recording") return "Stop recording";
  if (phase === "preview") return "Preview recording";
  return "Start recording";
};

export const VOICE_UI_CANCEL_ARIA = "Cancel recording";

export const toVoiceUiPhase = (
  impl: "idle" | "provider" | "browser" | "preview",
): VoiceUiPhase => {
  if (impl === "preview") return "preview";
  if (impl === "idle") return "idle";
  return "recording";
};

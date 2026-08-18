/**
 * Shared pill + composer recording vocabulary (i18n + tests).
 * Implementation may use provider/browser internally; UI speaks these three.
 */
export type VoiceUiPhase = "idle" | "recording" | "preview";

export const voiceUiAriaLabel = (phase: VoiceUiPhase): string => {
  if (phase === "recording") return "Stop recording";
  if (phase === "preview") return "Preview recording";
  return "Start recording";
};

export const toVoiceUiPhase = (
  impl: "idle" | "provider" | "browser" | "preview",
): VoiceUiPhase => {
  if (impl === "preview") return "preview";
  if (impl === "idle") return "idle";
  return "recording";
};

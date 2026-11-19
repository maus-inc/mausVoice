import { type MutableRefObject, useEffect } from "react";
import { buildWaveFile, ensureFloat32Array } from "../../utils/audio.utils";

export const createPreviewUrl = (
  rawSamples: number[] | Float32Array,
  sampleRate: number,
): string | null => {
  if (!sampleRate || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }

  const samples = ensureFloat32Array(rawSamples ?? []);
  if (samples.length === 0) {
    return null;
  }

  const wavBuffer = buildWaveFile(samples, sampleRate);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
};

export const usePreviewPlayback = ({
  previewUrl,
  previewAudioRef,
  setIsPreviewPlaying,
}: {
  previewUrl: string | null;
  previewAudioRef: MutableRefObject<HTMLAudioElement | null>;
  setIsPreviewPlaying: (playing: boolean) => void;
}) => {
  useEffect(() => {
    if (!previewUrl) {
      setIsPreviewPlaying(false);
      return;
    }

    const audio = new Audio(previewUrl);
    audio.preload = "auto";

    const handlePlay = () => setIsPreviewPlaying(true);
    const handlePause = () => setIsPreviewPlaying(false);
    const handleEnded = () => setIsPreviewPlaying(false);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    previewAudioRef.current = audio;

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
      }
    };
  }, [previewUrl, previewAudioRef, setIsPreviewPlaying]);
};

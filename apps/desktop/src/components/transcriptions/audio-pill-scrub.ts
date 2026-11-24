import { useCallback, useEffect, useRef, type RefObject } from "react";
import { seekPlayback } from "../../utils/audio-playback.utils";
import type { AudioPillPlayback } from "./use-audio-pill-playback";

/** How far one arrow key nudges the scrub position. */
const SCRUB_KEY_STEP = 0.05;

export const getScrubSeekForKey = (
  key: string,
  current: number,
): number | null => {
  if (key === "ArrowRight" || key === "ArrowUp") {
    return Math.min(1, current + SCRUB_KEY_STEP);
  }
  if (key === "ArrowLeft" || key === "ArrowDown") {
    return Math.max(0, current - SCRUB_KEY_STEP);
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return 1;
  }
  return null;
};

/** Client X to a 0..1 ratio over the track, or null when it cannot map. */
const getProgressFromClientX = (
  track: HTMLDivElement | null,
  clientX: number,
): number | null => {
  if (!track) return null;
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return null;
  const ratio = (clientX - rect.left) / rect.width;
  return Math.min(Math.max(ratio, 0), 1);
};

/** Move the scrub bar without touching the audio that is already playing. */
const previewSeek = (ratio: number, playback: AudioPillPlayback) => {
  playback.progressRef.current = ratio;
  playback.setProgress(ratio);
};

/** Move the scrub bar and seek the live session when one is playing. */
export const commitSeek = (ratio: number, playback: AudioPillPlayback) => {
  previewSeek(ratio, playback);
  if (playback.isPlayingRef.current) {
    seekPlayback(ratio);
  }
};

/**
 * Pointer scrubbing. Listener lifetime is scoped to one AbortController so
 * every exit path (release, cancel, re-entrant drag, unmount) runs one
 * teardown and the drag flag can never outlive its listeners: a stuck drag
 * flag mutes playback progress for good.
 */
export const useAudioPillDrag = ({
  transcriptionId,
  disabled,
  containerRef,
  playback,
}: {
  transcriptionId: string;
  disabled: boolean | undefined;
  containerRef: RefObject<HTMLDivElement | null>;
  playback: AudioPillPlayback;
}) => {
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const progressAtDragStartRef = useRef(0);

  // A row that switches clips mid-drag must drop that drag: its pointerup
  // would otherwise seek the clip it no longer shows.
  useEffect(() => {
    return () => {
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
    };
  }, [transcriptionId]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.focus();
      // Tear down any previous drag first: its endDrag clears the drag
      // flags and running it after the new state is set would clobber it.
      pointerCleanupRef.current?.();
      playback.isDraggingRef.current = true;
      progressAtDragStartRef.current = playback.progressRef.current;
      const next = getProgressFromClientX(containerRef.current, event.clientX);
      if (next != null) previewSeek(next, playback);

      const dragListeners = new AbortController();
      const endDrag = () => {
        dragListeners.abort();
        pointerCleanupRef.current = null;
        playback.isDraggingRef.current = false;
      };
      const handleMove = (moveEvent: PointerEvent) => {
        const ratio = getProgressFromClientX(
          containerRef.current,
          moveEvent.clientX,
        );
        if (ratio != null) previewSeek(ratio, playback);
      };
      const handleUp = (upEvent: PointerEvent) => {
        endDrag();
        const ratio = getProgressFromClientX(
          containerRef.current,
          upEvent.clientX,
        );
        if (ratio != null) {
          commitSeek(ratio, playback);
        } else {
          commitSeek(playback.progressRef.current, playback);
        }
      };
      const handleCancel = () => {
        endDrag();
        previewSeek(progressAtDragStartRef.current, playback);
      };
      const listenerOptions = { signal: dragListeners.signal };
      window.addEventListener("pointermove", handleMove, listenerOptions);
      window.addEventListener("pointerup", handleUp, {
        ...listenerOptions,
        once: true,
      });
      window.addEventListener("pointercancel", handleCancel, {
        ...listenerOptions,
        once: true,
      });
      pointerCleanupRef.current = endDrag;
    },
    [containerRef, disabled, playback],
  );

  return { handlePointerDown };
};

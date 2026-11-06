import {
  type PlaybackStopReason,
  stopActivePlayback,
} from "../../utils/audio-playback.utils";

// Tracks global ownership from the moment a row is chosen, including while
// audio bytes are loading and before the Web Audio context becomes active.
let activePlaybackOwner: symbol | null = null;

export type AudioPillPlaybackAttempt = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  isNonceCurrent: () => boolean;
  beginSetup: () => void;
  completeSetup: () => void;
  handleStopCallback: (reason: PlaybackStopReason) => boolean;
  releaseOnError: () => boolean;
};

export type AudioPillPlaybackSession = {
  beginRequest: () => AudioPillPlaybackAttempt;
  stopOwned: () => boolean;
};

export const createAudioPillPlaybackSession = (): AudioPillPlaybackSession => {
  let nonce = 0;
  let owner: symbol | null = null;
  let setupPending = false;

  let controller: AbortController | null = null;

  return {
    stopOwned(): boolean {
      nonce += 1;
      setupPending = false;
      const owned = Boolean(owner && activePlaybackOwner === owner);
      if (owned) {
        activePlaybackOwner = null;
        stopActivePlayback("stopped");
      }
      owner = null;
      // Teardown owns the abort: it settles in-flight Web Audio setup even
      // when global ownership already moved on (aborting is always safe).
      controller?.abort();
      controller = null;
      return owned;
    },

    beginRequest(): AudioPillPlaybackAttempt {
      controller?.abort();
      controller = new AbortController();
      const requestNonce = ++nonce;
      const requestOwner = Symbol("audio-pill-playback");
      owner = requestOwner;
      activePlaybackOwner = requestOwner;
      setupPending = false;
      stopActivePlayback("replaced");

      const isCurrent = () =>
        nonce === requestNonce &&
        owner === requestOwner &&
        activePlaybackOwner === requestOwner;

      return {
        signal: controller.signal,
        isCurrent,
        isNonceCurrent: () => nonce === requestNonce,
        beginSetup() {
          if (nonce === requestNonce) {
            setupPending = true;
          }
        },
        completeSetup() {
          if (nonce === requestNonce) {
            setupPending = false;
          }
        },
        handleStopCallback(reason: PlaybackStopReason): boolean {
          if (nonce !== requestNonce) {
            return false;
          }
          // A setup failure stops the just-published source before rejecting.
          // Retain ownership until releaseOnError reports that failure.
          if (!(
            setupPending &&
            reason === "stopped" &&
            activePlaybackOwner === requestOwner
          )) {
            if (activePlaybackOwner === requestOwner) {
              activePlaybackOwner = null;
            }
            if (owner === requestOwner) {
              owner = null;
            }
          }
          return true;
        },
        releaseOnError(): boolean {
          if (!isCurrent()) {
            return false;
          }
          activePlaybackOwner = null;
          owner = null;
          setupPending = false;
          return true;
        },
      };
    },
  };
};

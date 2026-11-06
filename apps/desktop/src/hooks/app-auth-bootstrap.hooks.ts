import { useEffect, useState } from "react";
import { canRunPostElevationInit } from "../actions/elevation.actions";
import { produceAppState, useAppStore } from "../store";
import { getLogger } from "../utils/log.utils";
import { resumePendingTranscriptionDeletes } from "../utils/pending-transcription-delete";
import { useAuthStateSync } from "./auth-state-sync.hooks";
import { useAuthenticatedProfileStream } from "./authenticated-profile-stream.hooks";
import { useElevationStartupReady } from "./elevation.hooks";
import { usePostElevationUserInit } from "./post-elevation-user-init.hooks";
import { useRemoteReceiverInit } from "./remote-receiver-init.hooks";

/** Gate user initialization on elevation, auth and the current profile session. */
export function useAppAuthBootstrap(isMainWindow: boolean) {
  const [authReady, setAuthReady] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [initReady, setInitReady] = useState(false);
  const userId = useAppStore((state) => state.auth?.uid ?? "");
  const initialized = useAppStore((state) => state.initialized);
  // Bumped whenever the signed-in identity changes. Subscribed to here because the
  // post-elevation init effect below has to re-run for the NEW user; see its deps.
  const authSessionNonce = useAppStore((state) => state.authSessionNonce);
  const elevationReady = useElevationStartupReady();

  useAuthStateSync({
    elevationReady,
    setAuthReady,
    setInitReady,
    setStreamReady,
  });

  useAuthenticatedProfileStream({
    elevationReady,
    authReady,
    userId,
    authSessionNonce,
    setStreamReady,
  });

  usePostElevationUserInit(
    elevationReady,
    authReady,
    authSessionNonce,
    setInitReady,
  );

  useRemoteReceiverInit(elevationReady, initReady, authSessionNonce);

  useEffect(() => {
    if (
      !canRunPostElevationInit(elevationReady, streamReady, initReady) ||
      initialized
    ) {
      return;
    }
    getLogger().info("App fully initialized");
    produceAppState((draft) => {
      draft.initialized = true;
    });
    if (isMainWindow) {
      resumePendingTranscriptionDeletes();
    }
  }, [streamReady, initReady, initialized, elevationReady, isMainWindow]);
}

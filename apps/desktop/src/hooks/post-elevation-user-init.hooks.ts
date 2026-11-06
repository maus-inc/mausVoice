import { canRunPostElevationInit } from "../actions/elevation.actions";
import { refreshCurrentUser } from "../actions/user.actions";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { useAsyncEffect } from "./async.hooks";

/** A refresh may finish after auth changes, the elevation gate closes, or unmount. */
export const usePostElevationUserInit = (
  elevationReady: boolean,
  authReady: boolean,
  authSessionNonce: number,
  setInitReady: (ready: boolean) => void,
) => {
  useAsyncEffect(
    async (isCancelled) => {
      if (!canRunPostElevationInit(elevationReady, authReady)) return;
      try {
        await refreshCurrentUser();
      } catch (error) {
        getLogger().error(`Failed to load the current user: ${error}`);
      }
      const state = getAppState();
      if (
        !isCancelled() &&
        state.authSessionNonce === authSessionNonce &&
        !state.settings.elevationStartupPending
      ) {
        // Refresh errors are non-fatal: onboarding must remain accessible.
        setInitReady(true);
      }
    },
    [authReady, elevationReady, authSessionNonce, setInitReady],
  );
};

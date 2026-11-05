import mixpanel from "mixpanel-browser";

let persistenceDisabledForClear = false;

/** Stop the analytics SDK from recreating its local queue during a data clear. */
export const disableAnalyticsPersistenceForLocalDataClear = (): void => {
  if (!import.meta.env.VITE_MIXPANEL_TOKEN || persistenceDisabledForClear) {
    return;
  }

  mixpanel.set_config({ disable_persistence: true });
  mixpanel.stop_session_recording();
  persistenceDisabledForClear = true;
};

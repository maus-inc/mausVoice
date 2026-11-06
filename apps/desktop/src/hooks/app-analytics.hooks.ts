import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../store";
import { getMyUserPreferences, LOCAL_USER_ID } from "../utils/user.utils";
import { useAnalyticsIdentity } from "./analytics-identity.hooks";
import { useAsyncData } from "./async.hooks";

/** Build analytics from the current initialized account and preferences. */
export function useAppAnalytics() {
  const versionData = useAsyncData(getVersion, []);
  const initialized = useAppStore((state) => state.initialized);
  const member = useAppStore((state) => {
    const uid = state.auth?.uid;
    return uid ? (state.memberById[uid] ?? null) : null;
  });
  const localUser = useAppStore(
    (state) => state.userById[LOCAL_USER_ID] ?? null,
  );
  const prefs = useAppStore((state) => getMyUserPreferences(state));
  const auth = useAppStore((state) => state.auth);
  useAnalyticsIdentity({
    initialized,
    auth,
    member,
    localUser,
    preferences: prefs,
    versionData,
  });
}

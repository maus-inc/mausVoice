import { useEffect, useRef } from "react";
import { detectLocale } from "../i18n";
import type { AsyncData } from "../types/async.types";
import type { AuthUser } from "../types/auth.types";
import {
  buildAnalyticsIdentity,
  buildFirstTouchProperties,
  buildPeopleProperties,
  buildSuperProperties,
  getMixpanel,
  type AnalyticsIdentity,
  type AnalyticsIdentitySources,
} from "../utils/analytics.utils";
import { getPlatform } from "../utils/platform.utils";

type MixpanelClient = NonNullable<ReturnType<typeof getMixpanel>>;

/** Retire a previous user even while the next user is still initializing. */
function retireChangedIdentity(
  mp: MixpanelClient,
  previous: string | null,
  current: string | null,
): boolean {
  if (!previous || previous === current) return false;
  mp.reset();
  return true;
}

/** Identify a newly ready user and record its first-touch properties. */
function transitionIdentity(
  mp: MixpanelClient,
  previous: string | null,
  current: string | null,
  identity: AnalyticsIdentity,
): void {
  if (!current || current === previous) return;
  mp.identify(current);
  const firstTouch = buildFirstTouchProperties(identity);
  mp.people.set_once({ $created: new Date().toISOString(), ...firstTouch });
  mp.register_once(firstTouch);
}

/** Keep Mixpanel's identity and first-touch state owned by the current user. */
export function useAnalyticsIdentity({
  initialized,
  auth,
  member,
  localUser,
  preferences,
  versionData,
}: {
  initialized: boolean;
  auth: AuthUser | null;
  member: AnalyticsIdentitySources["member"];
  localUser: AnalyticsIdentitySources["localUser"];
  preferences: AnalyticsIdentitySources["preferences"];
  versionData: AsyncData<string>;
}) {
  const previousUserId = useRef<string | null>(null);
  useEffect(() => {
    const mp = getMixpanel();
    if (!mp) return;
    const currentUserId = auth?.uid ?? null;
    if (retireChangedIdentity(mp, previousUserId.current, currentUserId)) {
      previousUserId.current = null;
    }
    if (!initialized) return;

    const identity = buildAnalyticsIdentity({
      userId: currentUserId,
      member,
      localUser,
      preferences,
      platform: getPlatform(),
      locale: detectLocale(),
    });
    transitionIdentity(mp, previousUserId.current, currentUserId, identity);
    mp.people.set(
      buildPeopleProperties(identity, {
        email: auth?.email,
        displayName: auth?.displayName,
      }),
    );
    mp.register(buildSuperProperties(identity));
    if (versionData.state === "success")
      mp.register({ appVersion: versionData.data });
    previousUserId.current = currentUserId;
  }, [initialized, auth, member, localUser, preferences, versionData]);
}

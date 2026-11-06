import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { showErrorSnackbar } from "../actions/app.actions";
import { canRunPostElevationInit } from "../actions/elevation.actions";
import { getAuthRepo } from "../repos";
import { INITIAL_ONBOARDING_STATE } from "../state/onboarding.state";
import { produceAppState } from "../store";
import type { AuthUser } from "../types/auth.types";
import { getLogger } from "../utils/log.utils";

type Setter = Dispatch<SetStateAction<boolean>>;
type IdentityRefs = {
  uid: { current: string | null };
  resolved: { current: boolean };
};
type Resetters = { setInitReady: Setter; setStreamReady: Setter };
const AUTH_READY_TIMEOUT_MS = 4_000;

function applyAuthState(
  user: AuthUser | null,
  refs: IdentityRefs,
  reset: Resetters,
) {
  const nextUid = user?.uid ?? null;
  const firstCallbackSeen = refs.resolved.current;
  const uidChanged = firstCallbackSeen && refs.uid.current !== nextUid;
  refs.resolved.current = true;
  getLogger().info(`Auth state changed (uid=${nextUid ?? "none"})`);
  produceAppState((draft) => {
    const previousUid = draft.auth?.uid ?? null;
    draft.auth = user;
    if (uidChanged || previousUid !== nextUid) {
      // These indicators belong to asynchronous work from the prior session.
      // Retiring them also permits a new run if the old request never settles.
      draft.transcriptions.retranscribingIds = [];
      draft.transcriptions.retranscriptionSuccessIds = [];
    }
    if (uidChanged) {
      refs.uid.current = nextUid;
      draft.authSessionNonce += 1;
      Object.assign(draft.onboarding, INITIAL_ONBOARDING_STATE);
      draft.local.onboardingResumePage = null;
      draft.local.onboardingNameDraft = "";
      draft.local.onboardingNameDraftUserId = null;
      draft.local.onboardingSessionUserId = nextUid;
      reset.setInitReady(false);
      reset.setStreamReady(false);
    } else if (!firstCallbackSeen) {
      refs.uid.current = nextUid;
      // Preserve resumable onboarding, but retire transient work belonging
      // to the identity that existed before initial auth resolution.
      if (previousUid !== nextUid) {
        draft.onboarding.submitting = false;
        draft.onboarding.dictationOverrideEnabled = false;
      }
      if (nextUid) draft.local.onboardingSessionUserId = nextUid;
    }
    draft.initialized = false;
  });
}

/** Own the auth listener and timeout only while the elevation gate is open. */
export function useAuthStateSync({
  elevationReady,
  setAuthReady,
  setInitReady,
  setStreamReady,
}: {
  elevationReady: boolean;
  setAuthReady: Dispatch<SetStateAction<boolean>>;
  setInitReady: Dispatch<SetStateAction<boolean>>;
  setStreamReady: Dispatch<SetStateAction<boolean>>;
}) {
  const uid = useRef<string | null>(null);
  // A first null callback still counts as resolved: a later sign-in is a new session.
  const resolved = useRef(false);
  useEffect(() => {
    if (!canRunPostElevationInit(elevationReady)) return;
    let active = true;
    let authReady = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const onChange = (user: AuthUser | null) => {
      if (!active) return;
      authReady = true;
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
      setAuthReady(true);
      applyAuthState(user, { uid, resolved }, { setInitReady, setStreamReady });
    };
    const onError = (error: unknown) => {
      if (!active) return;
      showErrorSnackbar(error);
      onChange(null);
    };
    timeout = setTimeout(() => {
      timeout = null;
      if (!authReady) {
        getLogger().warning("Auth timed out, proceeding without auth");
        onChange(null);
      }
    }, AUTH_READY_TIMEOUT_MS);
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = getAuthRepo().onAuthStateChanged(onChange, onError);
    } catch (error) {
      onError(error);
    }
    return () => {
      active = false;
      if (timeout !== null) clearTimeout(timeout);
      unsubscribe?.();
    };
  }, [elevationReady, setAuthReady, setInitReady, setStreamReady]);
}

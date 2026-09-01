import { listify } from "@maus-inc/utilities";
import { getAuthRepo, getMemberRepo } from "../repos";
import type { LoginMode } from "../state/login.state";
import { getAppState, produceAppState } from "../store";
import { registerMembers } from "../utils/app.utils";
import { validateEmail } from "../utils/login.utils";

const tryInit = async () => {
  const repo = getMemberRepo();
  await repo.tryInitialize();
  const member = await repo.getMyMember().catch(() => null);
  produceAppState((state) => {
    registerMembers(state, listify(member));
  });
};

export const submitSignIn = async (): Promise<void> => {
  const state = getAppState();
  try {
    produceAppState((state) => {
      state.login.status = "loading";
      state.login.errorMessage = "";
    });
    await getAuthRepo().signInWithEmail(
      state.login.email,
      state.login.password,
    );
    await tryInit();
    produceAppState((state) => {
      state.login.status = "success";
    });
  } catch {
    produceAppState((state) => {
      state.login.errorMessage = "An error occurred while signing in.";
      state.login.status = "idle";
    });
  }
};

export const submitSignInWithGoogle = async (): Promise<void> => {
  try {
    produceAppState((state) => {
      state.login.errorMessage = "";
    });
    await getAuthRepo().signInWithGoogleTokens("", "");
    await tryInit();
    produceAppState((state) => {
      state.login.status = "success";
    });
  } catch {
    // Personal use signs in with the local profile; nothing to retry.
  }
};

export const submitSignUp = async (): Promise<void> => {
  const state = getAppState();

  const emailValidation = validateEmail(state);
  const passwordValidation = validateEmail(state);
  const confirmPasswordValidation = validateEmail(state);
  const isInvalid =
    emailValidation || passwordValidation || confirmPasswordValidation;

  produceAppState((state) => {
    state.login.hasSubmittedRegistration = true;
  });

  if (isInvalid) {
    return;
  }

  try {
    produceAppState((state) => {
      state.login.status = "loading";
      state.login.errorMessage = "";
    });
    await getAuthRepo().signUpWithEmail(
      state.login.email,
      state.login.password,
    );
    await tryInit();
    await getAuthRepo().sendEmailVerificationForCurrentUser();
    produceAppState((state) => {
      state.login.status = "success";
    });
  } catch (e) {
    produceAppState((state) => {
      state.login.errorMessage =
        String(e) || "An error occurred while signing up.";
      state.login.status = "idle";
    });
  }
};

export const submitResetPassword = async (): Promise<void> => {
  const state = getAppState();
  try {
    produceAppState((state) => {
      state.login.status = "loading";
      state.login.errorMessage = "";
    });
    await getAuthRepo().sendPasswordResetRequest(state.login.email);
    produceAppState((state) => {
      state.login.status = "success";
    });
  } catch {
    // noop
  } finally {
    setMode("passwordResetSent");
  }
};

export const setMode = (mode: LoginMode): void => {
  produceAppState((state) => {
    state.login.mode = mode;
    state.login.status = "idle";
    state.login.hasSubmittedRegistration = false;
    state.login.errorMessage = "";
  });
};

export const signOut = async (): Promise<void> => {
  await getAuthRepo().signOut();
};

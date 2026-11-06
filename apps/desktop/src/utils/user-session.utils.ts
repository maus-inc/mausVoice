import { getAppState } from "../store";

/** Capture the current authentication session, including same-user re-logins. */
export const captureUserSession = (): (() => boolean) => {
  const state = getAppState();
  const userId = state.auth?.uid ?? null;
  const nonce = state.authSessionNonce;
  return () => {
    const current = getAppState();
    return (
      (current.auth?.uid ?? null) === userId &&
      current.authSessionNonce === nonce
    );
  };
};

export const requireUserSession = (isCurrent: () => boolean): void => {
  if (!isCurrent()) throw new Error("User session changed");
};

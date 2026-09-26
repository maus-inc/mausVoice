import { Nullable } from "@maus-inc/types";
import { getIsDevMode } from "../utils/env.utils";
import { getFirstAndLastName } from "../utils/string.utils";

export type OnboardingPageKey =
  | "signIn"
  | "personalCredentials"
  | "chooseTranscription"
  | "chooseLlm"
  | "userDetails"
  | "referralSource"
  | "micPerms"
  | "a11yPerms"
  | "keybindings"
  | "micCheck"
  | "unlockedPro"
  | "tutorial";

export type OnboardingState = {
  name: string;
  firstName: string;
  lastName: string;
  lastNameEnabled: boolean;
  title: string;
  currentPage: OnboardingPageKey;
  /** Ephemeral resume intent; ordinary navigation clears automatic permission skips. */
  isResuming: boolean;
  history: OnboardingPageKey[];
  submitting: boolean;
  tryItOutInput: string;
  loggingIn: boolean;
  preferredMicrophone: Nullable<string>;
  company: string;
  isMac: boolean;
  didSignUpWithAccount: boolean;
  referralSource: string;
  dictationOverrideEnabled: boolean;
  /** Uid for which we have already auto-advanced past signIn. Lives in
   *  Zustand state (not a component ref) so it survives SignInForm
   *  unmount/remount across Back navigation. */
  autoAdvancedForSessionUserId: string | null;
};

export type OnboardingNameDraft = Pick<
  OnboardingState,
  "name" | "firstName" | "lastName" | "lastNameEnabled"
>;

export const createOnboardingNameDraft = (
  fullName: string,
): OnboardingNameDraft => {
  const name = fullName.trim();
  const { firstName, lastName } = getFirstAndLastName(name);
  return {
    name,
    firstName: firstName ?? "",
    lastName: lastName ?? "",
    lastNameEnabled: lastName !== null,
  };
};

export const applyOnboardingNameDraft = (
  target: OnboardingNameDraft,
  source: OnboardingNameDraft,
): void => {
  target.name = source.name;
  target.firstName = source.firstName;
  target.lastName = source.lastName;
  target.lastNameEnabled = source.lastNameEnabled;
};

export const updateOnboardingFirstName = (
  draft: OnboardingNameDraft,
  firstName: string,
): OnboardingNameDraft => {
  const trimmedFirstName = firstName.trim();
  if (!trimmedFirstName) {
    return { ...draft, firstName };
  }

  const existing = draft.name.trim();
  const { firstName: existingFirstName } = getFirstAndLastName(existing);
  const lastName = draft.lastNameEnabled ? draft.lastName.trim() : "";
  let remainingName = "";
  if (!draft.firstName.trim() && existing === lastName) {
    remainingName = lastName;
  } else if (existingFirstName) {
    remainingName = existing.slice(existingFirstName.length).trim();
  }
  return {
    ...draft,
    name: [trimmedFirstName, remainingName].filter(Boolean).join(" "),
    firstName,
  };
};

export const updateOnboardingLastName = (
  draft: OnboardingNameDraft,
  lastName: string,
): OnboardingNameDraft => {
  const trimmedLastName = lastName.trim();
  const parts = draft.name.trim().split(/\s+/).filter(Boolean);
  const name =
    parts.length > 1
      ? [...parts.slice(0, -1), trimmedLastName].join(" ").trim()
      : [draft.firstName.trim(), trimmedLastName].filter(Boolean).join(" ");
  return {
    ...draft,
    name,
    lastName,
    lastNameEnabled: true,
  };
};

/** Releases the last-name field back to its inactive state, restoring the
 *  canonical name to the leading segment(s) of the existing canonical
 *  name with the final token stripped (so middle names the user typed
 *  are kept), falling back to just the trimmed first name when the
 *  name is a single token. */
export const clearOnboardingLastName = (
  draft: OnboardingNameDraft,
): OnboardingNameDraft => {
  const parts = draft.name.trim().split(/\s+/).filter(Boolean);
  const name =
    parts.length > 1 ? parts.slice(0, -1).join(" ") : draft.firstName.trim();
  return {
    ...draft,
    name,
    lastName: "",
    lastNameEnabled: false,
  };
};

export const isOnboardingNameDraftOwnedByAuth = (
  ownerId: string | null,
  authUid: string | null | undefined,
): boolean => ownerId === null || (Boolean(authUid) && ownerId === authUid);

export const resolveOnboardingName = (
  draft: OnboardingNameDraft,
  persistedName: string,
): string => {
  const canonicalName = draft.name.trim();
  if (canonicalName) return canonicalName;
  const persistedDraft = persistedName.trim();
  if (persistedDraft) return persistedDraft;
  return [
    draft.firstName.trim(),
    draft.lastNameEnabled ? draft.lastName.trim() : "",
  ]
    .filter(Boolean)
    .join(" ");
};

export const INITIAL_ONBOARDING_STATE: OnboardingState = {
  name: "",
  firstName: "",
  lastName: "",
  lastNameEnabled: false,
  title: "",
  currentPage: "signIn",
  isResuming: false,
  history: [],
  submitting: false,
  tryItOutInput: "",
  loggingIn: false,
  preferredMicrophone: null,
  company: "",
  isMac: false,
  didSignUpWithAccount: false,
  referralSource: "",
  dictationOverrideEnabled: false,
  autoAdvancedForSessionUserId: null,
};

if (getIsDevMode()) {
  INITIAL_ONBOARDING_STATE.name = "Emulator User";
  INITIAL_ONBOARDING_STATE.firstName = "Emulator";
  INITIAL_ONBOARDING_STATE.lastName = "User";
  INITIAL_ONBOARDING_STATE.lastNameEnabled = true;
}

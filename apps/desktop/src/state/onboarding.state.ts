import { Nullable } from "@maus-inc/types";
import { getIsDevMode } from "../utils/env.utils";

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
  title: string;
  currentPage: OnboardingPageKey;
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
  awaitingSignInNavigation: boolean;
};

export const INITIAL_ONBOARDING_STATE: OnboardingState = {
  name: "",
  title: "",
  currentPage: "signIn",
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
  awaitingSignInNavigation: false,
};

if (getIsDevMode()) {
  INITIAL_ONBOARDING_STATE.name = "Emulator User";
}

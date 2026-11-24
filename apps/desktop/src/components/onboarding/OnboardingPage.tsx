import { Stack } from "@mui/material";
import { useEffect, useState, type ComponentType } from "react";
import {
  ensureOnboardingFlow,
  markOnboardingStepEntered,
  resumeOnboardingPage,
} from "../../actions/onboarding.actions";
import { trackOnboardingStep } from "../../utils/analytics.utils";
import { useAppStore } from "../../store";
import { A11yPermsForm } from "./A11yPermsForm";
import { ChooseLlmForm } from "./ChooseLlmForm";
import { ChooseTranscriptionForm } from "./ChooseTranscriptionForm";
import { KeybindingsForm } from "./KeybindingsForm";
import { PersonalCredentialsForm } from "./PersonalCredentialsForm";
import { MicCheckForm } from "./MicCheckForm";
import { MicPermsForm } from "./MicPermsForm";
import { ReferralSourceForm } from "./ReferralSourceForm";
import { SignInForm } from "./SignInForm";
import { TutorialForm } from "./TutorialForm";
import { UnlockedProForm } from "./UnlockedProForm";
import { UserDetailsForm } from "./UserDetailsForm";
import type { OnboardingPageKey } from "../../state/onboarding.state";

const PAGE_FORMS: Record<OnboardingPageKey, ComponentType> = {
  signIn: SignInForm,
  personalCredentials: PersonalCredentialsForm,
  chooseTranscription: ChooseTranscriptionForm,
  chooseLlm: ChooseLlmForm,
  userDetails: UserDetailsForm,
  referralSource: ReferralSourceForm,
  micPerms: MicPermsForm,
  a11yPerms: A11yPermsForm,
  keybindings: KeybindingsForm,
  micCheck: MicCheckForm,
  unlockedPro: UnlockedProForm,
  tutorial: TutorialForm,
};

export default function OnboardingPage() {
  const currentPage = useAppStore((state) => state.onboarding.currentPage);
  const authUid = useAppStore((state) => state.auth?.uid);
  const initialized = useAppStore((state) => state.initialized);
  const authSessionNonce = useAppStore((state) => state.authSessionNonce);
  const [resumeCheckedNonce, setResumeCheckedNonce] = useState<number | null>(
    null,
  );

  useEffect(() => {
    ensureOnboardingFlow();
    resumeOnboardingPage();
    setResumeCheckedNonce(authSessionNonce);
  }, [authSessionNonce, authUid, initialized]);

  useEffect(() => {
    markOnboardingStepEntered(currentPage);
    trackOnboardingStep(`v3_${currentPage}`);
  }, [currentPage]);

  if (
    resumeCheckedNonce !== authSessionNonce ||
    (authUid !== undefined && !initialized)
  )
    return null;

  const PageForm = PAGE_FORMS[currentPage];

  return (
    <Stack
      direction="row"
      sx={{
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
      }}
    >
      <PageForm />
    </Stack>
  );
}

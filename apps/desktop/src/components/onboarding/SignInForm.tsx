import { Box } from "@mui/material";
import { useEffect, useState } from "react";
import walkingImage from "../../assets/1-walking.png";
import {
  goToOnboardingPage,
  setDidSignUpWithAccount,
} from "../../actions/onboarding.actions";
import {
  applyOnboardingNameDraft,
  createOnboardingNameDraft,
} from "../../state/onboarding.state";
import { produceAppState, useAppStore } from "../../store";
import { isPersonalUseEnabled } from "../../utils/personal-use.utils";
import { getMyUser } from "../../utils/user.utils";
import { DualPaneLayout } from "./OnboardingCommon";
import { SignInAccountStep } from "./SignInAccountStep";
import { SignInNameStep } from "./SignInNameStep";

export const SignInForm = () => {
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const auth = useAppStore((state) => state.auth);
  const isPersonalUse = isPersonalUseEnabled();
  const onboardingResumePage = useAppStore(
    (state) => state.local.onboardingResumePage,
  );
  const initialized = useAppStore((state) => state.initialized);
  const existingUser = useAppStore((state) => getMyUser(state));
  const existingName = existingUser?.name?.trim() ?? "";
  const autoAdvancedForSessionUserId = useAppStore(
    (state) => state.onboarding.autoAdvancedForSessionUserId,
  );

  useEffect(() => {
    if (!auth || !initialized || existingName === "") return;
    produceAppState((draft) => {
      const nameDraft = createOnboardingNameDraft(existingName);
      applyOnboardingNameDraft(draft.onboarding, nameDraft);
      draft.local.onboardingNameDraft = nameDraft.name;
      draft.local.onboardingNameDraftUserId = auth.uid;
      draft.local.onboardingSessionUserId = auth.uid;
    });
    if (onboardingResumePage && onboardingResumePage !== "signIn") return;
    if (autoAdvancedForSessionUserId === auth.uid) return;
    produceAppState((draft) => {
      draft.onboarding.autoAdvancedForSessionUserId = auth.uid;
    });
    setEmailDialogOpen(false);
    setDidSignUpWithAccount(!isPersonalUse);
    goToOnboardingPage(
      isPersonalUse ? "personalCredentials" : "chooseTranscription",
    );
  }, [
    auth,
    autoAdvancedForSessionUserId,
    existingName,
    initialized,
    isPersonalUse,
    onboardingResumePage,
  ]);

  const form = auth ? (
    <SignInNameStep />
  ) : (
    <SignInAccountStep
      emailDialogOpen={emailDialogOpen}
      onEmailDialogOpenChange={setEmailDialogOpen}
    />
  );

  return (
    <DualPaneLayout
      left={form}
      right={
        <Box
          component="img"
          src={walkingImage}
          alt="Illustration"
          sx={{ maxWidth: 400, maxHeight: 400 }}
        />
      }
    />
  );
};

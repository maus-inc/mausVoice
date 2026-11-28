import { Box, Stack } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import designerImage from "../../assets/3-designer.png";
import { AIPostProcessingConfiguration } from "../settings/AIPostProcessingConfiguration";
import {
  BackButton,
  DualPaneLayout,
  OnboardingContinueButton,
  OnboardingFormHeader,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const ChooseLlmForm = () => {
  const { mode, selectedApiKeyId } = useAppStore(
    (state) => state.settings.aiPostProcessing,
  );

  const canContinue = mode === "api" ? Boolean(selectedApiKeyId) : true;

  const handleContinue = () => {
    trackButtonClick("onboarding_llm_continue");
    goToOnboardingPage("userDetails");
  };

  const form = (
    <OnboardingFormLayout
      back={<BackButton />}
      actions={
        <OnboardingContinueButton
          onClick={handleContinue}
          disabled={!canContinue}
        />
      }
    >
      <Stack spacing={3}>
        <OnboardingFormHeader
          title={<FormattedMessage defaultMessage="Set up post-processing" />}
          subtitle={
            <FormattedMessage defaultMessage="Choose if mausVoice should enhance transcripts automatically after they are transcribed." />
          }
        />

        <AIPostProcessingConfiguration />
      </Stack>
    </OnboardingFormLayout>
  );

  const rightContent = (
    <Box
      component="img"
      src={designerImage}
      alt="Illustration"
      sx={{ maxWidth: 400, maxHeight: 400 }}
    />
  );

  return <DualPaneLayout left={form} right={rightContent} />;
};

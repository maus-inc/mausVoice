import { Box, Stack } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import remoteImage from "../../assets/2-remote.png";
import { AITranscriptionConfiguration } from "../settings/AITranscriptionConfiguration";
import {
  BackButton,
  DualPaneLayout,
  OnboardingContinueButton,
  OnboardingFormHeader,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const ChooseTranscriptionForm = () => {
  const { mode, selectedApiKeyId } = useAppStore(
    (state) => state.settings.aiTranscription,
  );

  const canContinue = mode === "api" ? Boolean(selectedApiKeyId) : true;

  const handleContinue = () => {
    trackButtonClick("onboarding_transcription_continue");
    goToOnboardingPage("chooseLlm");
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
          title={<FormattedMessage defaultMessage="Set up transcription" />}
          subtitle={
            <FormattedMessage defaultMessage="Decide how mausVoice should process your recordings. Locally or through an API." />
          }
        />

        <AITranscriptionConfiguration />
      </Stack>
    </OnboardingFormLayout>
  );

  const rightContent = (
    <Box
      component="img"
      src={remoteImage}
      alt="Illustration"
      sx={{ maxWidth: 400, maxHeight: 400 }}
    />
  );

  return <DualPaneLayout left={form} right={rightContent} />;
};

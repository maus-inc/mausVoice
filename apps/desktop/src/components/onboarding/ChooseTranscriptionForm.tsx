import { Box, Stack } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { isMacOS } from "../../utils/env.utils";
import { AITranscriptionConfiguration } from "../settings/AITranscriptionConfiguration";
import { AudioTransmissionDisclosure } from "../settings/AudioTransmissionDisclosure";
import {
  BackButton,
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
    goToOnboardingPage(isMacOS() ? "micPerms" : "keybindings");
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

        <AITranscriptionConfiguration compactCards />

        <AudioTransmissionDisclosure />
      </Stack>
    </OnboardingFormLayout>
  );

  return (
    <Box
      sx={{
        height: "100%",
        width: "100%",
        maxWidth: 840,
        mx: "auto",
        px: { xs: 2, sm: 5 },
        pt: 2,
        pb: 5,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {form}
    </Box>
  );
};

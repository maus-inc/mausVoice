import { Box, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { isMacOS } from "../../utils/env.utils";
import { getIsCloudTranscriptionSelected } from "../../utils/transcription-privacy.utils";
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
  const isCloudTranscriptionSelected = useAppStore(
    getIsCloudTranscriptionSelected,
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

        <AITranscriptionConfiguration />

        {isCloudTranscriptionSelected && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            <FormattedMessage defaultMessage="Audio is sent to your provider as you speak, not only after you stop. Cancelling cannot recall it." />
          </Typography>
        )}
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

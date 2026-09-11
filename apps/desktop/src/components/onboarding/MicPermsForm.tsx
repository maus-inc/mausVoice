import { Box, Stack } from "@mui/material";
import { useCallback, useState } from "react";
import { FormattedMessage } from "react-intl";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import enableMicVideo from "../../assets/enable-mic.mp4";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  isPermissionAuthorized,
  requestMicrophonePermission,
} from "../../utils/permission.utils";
import { isPersonalUseEnabled } from "../../utils/personal-use.utils";
import { isMacOS } from "../../utils/env.utils";
import { PermissionAccessButton } from "./PermissionAccessButton";
import {
  BackButton,
  DualPaneLayout,
  OnboardingContinueButton,
  OnboardingFormHeader,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const MicPermsForm = () => {
  const [requesting, setRequesting] = useState(false);
  const micPermission = useAppStore((state) => state.permissions.microphone);
  const isAuthorized = isPermissionAuthorized(micPermission?.state);
  const canContinue =
    isAuthorized ||
    (isPersonalUseEnabled() && micPermission?.promptShown === true);

  const handleAllow = useCallback(async () => {
    if (requesting || isAuthorized) {
      return;
    }

    trackButtonClick("onboarding_mic_allow_access");
    setRequesting(true);
    try {
      const result = await requestMicrophonePermission();
      produceAppState((draft) => {
        draft.permissions.microphone = result;
      });
    } catch (error) {
      console.error("Failed to request microphone permission", error);
    } finally {
      setRequesting(false);
    }
  }, [requesting, isAuthorized]);

  const handleContinue = () => {
    trackButtonClick("onboarding_mic_perms_continue");
    goToOnboardingPage(isMacOS() ? "a11yPerms" : "keybindings");
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
          title={<FormattedMessage defaultMessage="Set up your microphone" />}
          subtitle={
            <FormattedMessage defaultMessage="mausVoice only activates your microphone when you choose to start recording." />
          }
        />

        <PermissionAccessButton
          isAuthorized={isAuthorized}
          requesting={requesting}
          onAllow={() => void handleAllow()}
        />
      </Stack>
    </OnboardingFormLayout>
  );

  const rightContent = (
    <Box
      sx={{
        borderRadius: "24px",
        border: "1px solid gray",
        overflow: "hidden",
        maxHeight: "100%",
        margin: 8,
      }}
    >
      <Box
        component="video"
        src={enableMicVideo}
        autoPlay
        loop
        muted
        playsInline
        sx={{
          display: "block",
          margin: "-10px",
          width: "auto",
          height: "auto",
          maxWidth: "calc(100% + 20px)",
          maxHeight: "calc(100% + 20px)",
        }}
      />
    </Box>
  );

  return (
    <DualPaneLayout
      left={form}
      right={rightContent}
      rightSx={{
        bgcolor: "transparent",
      }}
    />
  );
};

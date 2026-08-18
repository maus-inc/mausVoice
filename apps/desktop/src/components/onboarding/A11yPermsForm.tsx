import { ArrowForward, Check, OpenInNew } from "@mui/icons-material";
import { Box, Button, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { FormattedMessage } from "react-intl";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import enableA11yVideo from "../../assets/enable-a11y.mp4";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  isPermissionAuthorized,
  requestAccessibilityPermission,
} from "../../utils/permission.utils";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const A11yPermsForm = () => {
  const [requesting, setRequesting] = useState(false);
  const a11yPermission = useAppStore(
    (state) => state.permissions.accessibility,
  );
  const isAuthorized = isPermissionAuthorized(a11yPermission?.state);

  const handleAllow = useCallback(async () => {
    if (requesting || isAuthorized) {
      return;
    }

    trackButtonClick("onboarding_a11y_allow_access");
    setRequesting(true);
    try {
      const result = await requestAccessibilityPermission();
      produceAppState((draft) => {
        draft.permissions.accessibility = result;
      });
    } catch (error) {
      console.error("Failed to request accessibility permission", error);
    } finally {
      setRequesting(false);
    }
  }, [requesting, isAuthorized]);

  const handleContinue = () => {
    trackButtonClick("onboarding_a11y_perms_continue");
    goToOnboardingPage("keybindings");
  };

  const handleSkip = () => {
    trackButtonClick("onboarding_a11y_perms_skip");
    goToOnboardingPage("keybindings");
  };

  const form = (
    <OnboardingFormLayout
      back={<BackButton />}
      actions={
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
          }}
        >
          {/*
            Onboarding must never dead-end. If the permission state is stuck
            (declined, or a platform that reports no state at all) the user can
            still continue; PermissionSideEffects keeps polling, so access
            granted later is picked up without a restart.
          */}
          {!isAuthorized && (
            <Button onClick={handleSkip} sx={{ color: "text.secondary" }}>
              <FormattedMessage defaultMessage="Skip for now" />
            </Button>
          )}
          <Button
            variant="contained"
            endIcon={<ArrowForward />}
            onClick={handleContinue}
          >
            <FormattedMessage defaultMessage="Continue" />
          </Button>
        </Stack>
      }
    >
      <Stack spacing={3}>
        <Box>
          <Typography
            variant="h4"
            sx={{
              fontWeight: 600,
              pb: 1,
            }}
          >
            <FormattedMessage defaultMessage="Enable accessibility" />
          </Typography>
          <Typography
            variant="body1"
            sx={{
              color: "text.secondary",
            }}
          >
            <FormattedMessage defaultMessage="mausVoice needs accessibility permissions to paste transcriptions into focused text fields." />
          </Typography>
        </Box>

        {isAuthorized ? (
          <Button
            variant="outlined"
            color="success"
            startIcon={<Check />}
            disabled
            sx={{ alignSelf: "flex-start" }}
          >
            <FormattedMessage defaultMessage="Access granted" />
          </Button>
        ) : (
          <Button
            variant="outlined"
            onClick={() => void handleAllow()}
            disabled={requesting}
            endIcon={<OpenInNew />}
            sx={{ alignSelf: "flex-start" }}
          >
            <FormattedMessage defaultMessage="Allow access" />
          </Button>
        )}
      </Stack>
    </OnboardingFormLayout>
  );

  const rightContent = (
    <Box
      sx={{
        borderRadius: "12px",
        border: "1px solid gray",
        overflow: "hidden",
        maxHeight: "100%",
      }}
    >
      <Box
        component="video"
        src={enableA11yVideo}
        autoPlay
        loop
        muted
        playsInline
        sx={{
          display: "block",
          margin: "-2px",
          width: "auto",
          height: "auto",
          maxWidth: "calc(100% + 4px)",
          maxHeight: "calc(100% + 4px)",
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

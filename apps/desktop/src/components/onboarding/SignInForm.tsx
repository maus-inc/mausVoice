import { ArrowForward, Email } from "@mui/icons-material";
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import walkingImage from "../../assets/1-walking.png";
import { signOut } from "../../actions/login.actions";
import {
  goToOnboardingPage,
  setAwaitingSignInNavigation,
  setDidSignUpWithAccount,
} from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { getShouldShowEmailForm } from "../../utils/login.utils";
import { isPersonalUseEnabled } from "../../utils/personal-use.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { LoginForm } from "../login/LoginForm";
import { TermsNotice } from "../login/TermsNotice";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const SignInForm = () => {
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [confirmLocalSetupOpen, setConfirmLocalSetupOpen] = useState(false);

  const auth = useAppStore((state) => state.auth);
  const isPersonalUse = isPersonalUseEnabled();
  const loginStatus = useAppStore((state) => state.login.status);
  const awaitingSignInNavigation = useAppStore(
    (state) => state.onboarding.awaitingSignInNavigation,
  );
  const isSignedIn = Boolean(auth);
  const showEmailButton = useAppStore((state) => getShouldShowEmailForm(state));

  useEffect(() => {
    if (isSignedIn && awaitingSignInNavigation) {
      setAwaitingSignInNavigation(false);
      setEmailDialogOpen(false);
      setDidSignUpWithAccount(!isPersonalUse);
      goToOnboardingPage(isPersonalUse ? "personalCredentials" : "userDetails");
    }
  }, [isSignedIn, awaitingSignInNavigation, isPersonalUse]);

  const handleClickLocalSetup = () => {
    trackButtonClick("onboarding_local_setup");
    setConfirmLocalSetupOpen(true);
  };

  const handleConfirmLocalSetup = () => {
    trackButtonClick("onboarding_confirm_local_setup");
    setConfirmLocalSetupOpen(false);
    setDidSignUpWithAccount(false);
    goToOnboardingPage(
      isPersonalUse ? "personalCredentials" : "chooseTranscription",
    );
  };

  const handleCancelLocalSetup = () => {
    trackButtonClick("onboarding_cancel_local_setup");
    setConfirmLocalSetupOpen(false);
  };

  const handleOpenEmailDialog = () => {
    trackButtonClick("onboarding_sign_up_with_email");
    setAwaitingSignInNavigation(true);
    setEmailDialogOpen(true);
  };

  const handleCloseEmailDialog = () => {
    setAwaitingSignInNavigation(false);
    setEmailDialogOpen(false);
  };

  const handleContinue = () => {
    trackButtonClick("onboarding_continue_signed_in");
    setDidSignUpWithAccount(!isPersonalUse);
    goToOnboardingPage(isPersonalUse ? "personalCredentials" : "userDetails");
  };

  const handleSignOut = async () => {
    trackButtonClick("onboarding_sign_out");
    await signOut();
  };

  const rightContent = (
    <Box
      component="img"
      src={walkingImage}
      alt="Illustration"
      sx={{ maxWidth: 400, maxHeight: 400 }}
    />
  );

  const signedInContent = (
    <OnboardingFormLayout
      actions={
        <Button
          variant="contained"
          endIcon={<ArrowForward />}
          onClick={handleContinue}
        >
          <FormattedMessage defaultMessage="Continue" />
        </Button>
      }
    >
      <Stack spacing={2}>
        <Typography
          variant="h4"
          sx={{
            fontWeight: 500,
            pb: 1,
            fontFamily: "var(--font-display)",
            letterSpacing: "0.01em",
          }}
        >
          <FormattedMessage defaultMessage="Welcome back" />
        </Typography>

        <Typography
          variant="body1"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage
            defaultMessage="You are signed in as {email}"
            values={{ email: auth?.email }}
          />
        </Typography>

        <Link
          component="button"
          variant="body2"
          onClick={handleSignOut}
          sx={{ alignSelf: "flex-start" }}
        >
          <FormattedMessage defaultMessage="Sign out" />
        </Link>
      </Stack>
    </OnboardingFormLayout>
  );

  const signInContent = (
    <OnboardingFormLayout
      back={<BackButton />}
      actions={
        <Button
          onClick={handleClickLocalSetup}
          variant="text"
          endIcon={<ArrowForward />}
          sx={{ color: "text.disabled", fontWeight: 400 }}
        >
          <FormattedMessage defaultMessage="Local set up" />
        </Button>
      }
    >
      <Stack spacing={2}>
        <Typography
          variant="h4"
          sx={{
            fontWeight: 600,
            pb: 1,
          }}
        >
          <FormattedMessage defaultMessage="Create your account" />
        </Typography>

        {showEmailButton && (
          <Button
            fullWidth
            variant="outlined"
            startIcon={<Email />}
            onClick={handleOpenEmailDialog}
            disabled={loginStatus === "loading"}
          >
            <FormattedMessage defaultMessage="Sign up with email" />
          </Button>
        )}

        <TermsNotice align="left" />
      </Stack>

      <Dialog
        open={emailDialogOpen}
        onClose={handleCloseEmailDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogContent>
          <LoginForm hideModeSwitch defaultMode="signUp" />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        isOpen={confirmLocalSetupOpen}
        onCancel={handleCancelLocalSetup}
        onConfirm={handleConfirmLocalSetup}
        title={<FormattedMessage defaultMessage="⚠️ Advanced Setup Required" />}
        content={
          <FormattedMessage defaultMessage="Local set up is complicated and requires a strong technical background. We recommend the free plan for most users." />
        }
        confirmLabel={<FormattedMessage defaultMessage="Accept" />}
        cancelLabel={<FormattedMessage defaultMessage="Go back" />}
      />
    </OnboardingFormLayout>
  );

  const form = isSignedIn ? signedInContent : signInContent;

  return <DualPaneLayout left={form} right={rightContent} />;
};

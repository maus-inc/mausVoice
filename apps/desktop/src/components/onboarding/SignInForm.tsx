import { ArrowForward, Email } from "@mui/icons-material";
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import walkingImage from "../../assets/1-walking.png";
import {
  goToOnboardingPage,
  setAwaitingSignInNavigation,
  setDidSignUpWithAccount,
} from "../../actions/onboarding.actions";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { getShouldShowEmailForm } from "../../utils/login.utils";
import { isPersonalUseEnabled } from "../../utils/personal-use.utils";
import { getFirstAndLastName } from "../../utils/string.utils";
import { getMyUser } from "../../utils/user.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { LoginForm } from "../login/LoginForm";
import { TermsNotice } from "../login/TermsNotice";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const SignInForm = () => {
  const intl = useIntl();
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

  const existingUser = useAppStore((state) => getMyUser(state));
  const existingName = existingUser?.name?.trim() ?? "";

  const firstName = useAppStore((state) => state.onboarding.firstName);
  const lastName = useAppStore((state) => state.onboarding.lastName);
  const lastNameEnabled = useAppStore((state) => state.onboarding.lastNameEnabled);

  // Prefill name fields from the auth provider's displayName on first sign-in
  // if nothing has been entered yet.
  useEffect(() => {
    if (!isSignedIn) return;
    if (firstName.trim() !== "") return;
    const dn = auth?.displayName;
    if (!dn) return;
    const { firstName: fn, lastName: ln } = getFirstAndLastName(dn);
    if (fn) {
      produceAppState((draft) => {
        draft.onboarding.firstName = fn;
        if (ln) {
          draft.onboarding.lastName = ln;
          draft.onboarding.lastNameEnabled = true;
        }
        draft.onboarding.name = [fn, ln].filter(Boolean).join(" ");
      });
    }
  }, [auth, isSignedIn, firstName]);

  useEffect(() => {
    // Returning user (already onboarded or has a name persisted): skip the
    // name-collection step entirely.
    if (isSignedIn && existingName !== "") {
      const { firstName: efn, lastName: eln } = getFirstAndLastName(existingName);
      produceAppState((draft) => {
        if (efn) draft.onboarding.firstName = efn;
        if (eln) {
          draft.onboarding.lastName = eln;
          draft.onboarding.lastNameEnabled = true;
        }
        draft.onboarding.name = existingName;
      });
      setAwaitingSignInNavigation(false);
      setEmailDialogOpen(false);
      setDidSignUpWithAccount(!isPersonalUse);
      goToOnboardingPage(
        isPersonalUse ? "personalCredentials" : "chooseTranscription",
      );
      return;
    }
    // Only auto-navigate once the user has supplied their first name so the
    // name-collection step can't be skipped.
    if (isSignedIn && awaitingSignInNavigation && firstName.trim() !== "") {
      setAwaitingSignInNavigation(false);
      setEmailDialogOpen(false);
      setDidSignUpWithAccount(!isPersonalUse);
      goToOnboardingPage(
        isPersonalUse ? "personalCredentials" : "chooseTranscription",
      );
    }
  }, [isSignedIn, awaitingSignInNavigation, isPersonalUse, firstName, existingName]);

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

  const syncName = (fn: string, ln: string, lnEnabled: boolean) =>
    [fn.trim(), lnEnabled ? ln.trim() : ""].filter(Boolean).join(" ");

  const handleFirstNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    produceAppState((draft) => {
      draft.onboarding.firstName = value;
      draft.onboarding.name = syncName(value, draft.onboarding.lastName, draft.onboarding.lastNameEnabled);
    });
  };

  const handleFirstNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.firstName = e.target.value.trim();
    });
  };

  const handleLastNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    produceAppState((draft) => {
      draft.onboarding.lastName = value;
      draft.onboarding.lastNameEnabled = true;
      draft.onboarding.name = syncName(draft.onboarding.firstName, value, true);
    });
  };

  const handleLastNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.lastName = e.target.value.trim();
    });
  };

  const handleLastNameActivate = () => {
    produceAppState((draft) => {
      draft.onboarding.lastNameEnabled = true;
    });
  };

  const handleContinue = () => {
    if (firstName.trim() === "") return;
    trackButtonClick("onboarding_continue_signed_in");
    setDidSignUpWithAccount(!isPersonalUse);
    goToOnboardingPage(
      isPersonalUse ? "personalCredentials" : "chooseTranscription",
    );
  };

  const canContinue = firstName.trim() !== "";

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
          disabled={!canContinue}
        >
          <FormattedMessage defaultMessage="Continue" />
        </Button>
      }
    >
      <Stack spacing={2.5}>
        <Typography
          variant="h4"
          sx={{
            fontWeight: 500,
            pb: 0.5,
            fontFamily: "var(--font-display)",
            letterSpacing: "0.01em",
          }}
        >
          <FormattedMessage defaultMessage="Welcome" />
        </Typography>

        <Typography
          variant="body1"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage
            defaultMessage="Signed in as {email}"
            values={{ email: auth?.email }}
          />
        </Typography>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField
            variant="outlined"
            size="small"
            label={<FormattedMessage defaultMessage="First name" />}
            placeholder={intl.formatMessage({ defaultMessage: "John" })}
            value={firstName}
            onChange={handleFirstNameChange}
            onBlur={handleFirstNameBlur}
            autoFocus
            autoComplete="given-name"
            fullWidth
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: {
                "data-mausvoice-ignore": "true",
              },
            }}
          />
          <TextField
            variant="outlined"
            size="small"
            label={<FormattedMessage defaultMessage="Last name" />}
            placeholder={intl.formatMessage({ defaultMessage: "Doe" })}
            value={lastName}
            onChange={handleLastNameChange}
            onBlur={handleLastNameBlur}
            onFocus={handleLastNameActivate}
            onClick={handleLastNameActivate}
            disabled={!lastNameEnabled}
            autoComplete="family-name"
            fullWidth
            sx={
              !lastNameEnabled
                ? {
                    "& .MuiInputBase-input.Mui-disabled": {
                      color: "text.disabled",
                      WebkitTextFillColor: "unset",
                      opacity: 0.6,
                    },
                    "& .MuiInputLabel-root": {
                      color: "text.disabled",
                    },
                    "& .MuiOutlinedInput-notchedOutline": {
                      borderColor: "divider",
                    },
                    "&:hover .MuiOutlinedInput-notchedOutline": {
                      borderColor: "text.secondary",
                    },
                  }
                : undefined
            }
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: {
                "data-mausvoice-ignore": "true",
              },
            }}
          />
        </Stack>
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

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
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import walkingImage from "../../assets/1-walking.png";
import {
  goToOnboardingPage,
  setDidSignUpWithAccount,
} from "../../actions/onboarding.actions";
import {
  applyOnboardingNameDraft,
  createOnboardingNameDraft,
  isOnboardingNameDraftOwnedByAuth,
  updateOnboardingFirstName,
  updateOnboardingLastName,
} from "../../state/onboarding.state";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { getShouldShowEmailForm } from "../../utils/login.utils";
import { isPersonalUseEnabled } from "../../utils/personal-use.utils";
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
  const prefilledNameSource = useRef<string | null>(null);

  const auth = useAppStore((state) => state.auth);
  const isPersonalUse = isPersonalUseEnabled();
  const loginStatus = useAppStore((state) => state.login.status);
  const onboardingNameDraft = useAppStore(
    (state) => state.local.onboardingNameDraft,
  );
  const onboardingNameDraftUserId = useAppStore(
    (state) => state.local.onboardingNameDraftUserId,
  );
  const onboardingResumePage = useAppStore(
    (state) => state.local.onboardingResumePage,
  );
  const isSignedIn = Boolean(auth);
  const showEmailButton = useAppStore((state) => getShouldShowEmailForm(state));

  const existingUser = useAppStore((state) => getMyUser(state));
  const existingName = existingUser?.name?.trim() ?? "";

  const firstName = useAppStore((state) => state.onboarding.firstName);
  const lastName = useAppStore((state) => state.onboarding.lastName);
  const lastNameEnabled = useAppStore(
    (state) => state.onboarding.lastNameEnabled,
  );

  useEffect(() => {
    if (!isSignedIn || !auth) {
      prefilledNameSource.current = null;
      return;
    }
    const draftBelongsToUser = isOnboardingNameDraftOwnedByAuth(
      onboardingNameDraftUserId,
      auth.uid,
    );
    const hasUsableDraft = draftBelongsToUser && Boolean(onboardingNameDraft);
    const providerName = auth.providers.includes("personal")
      ? ""
      : (auth.displayName ?? "");
    const prefillName = hasUsableDraft ? onboardingNameDraft : providerName;
    const prefillSource = hasUsableDraft
      ? `draft:${auth.uid}`
      : `provider:${auth.uid}:${providerName}`;
    if (prefilledNameSource.current === prefillSource) return;
    prefilledNameSource.current = prefillSource;
    produceAppState((draft) => {
      if (onboardingNameDraft && !draftBelongsToUser) {
        draft.local.onboardingNameDraft = "";
        draft.local.onboardingNameDraftUserId = null;
        draft.local.onboardingSessionUserId = auth.uid;
        if (!prefillName) {
          applyOnboardingNameDraft(
            draft.onboarding,
            createOnboardingNameDraft(""),
          );
          return;
        }
      }
      if (!prefillName) return;
      const nameDraft = createOnboardingNameDraft(prefillName);
      applyOnboardingNameDraft(draft.onboarding, nameDraft);
      draft.local.onboardingNameDraft = nameDraft.name;
      draft.local.onboardingNameDraftUserId = auth.uid;
      draft.local.onboardingSessionUserId = auth.uid;
    });
  }, [auth, isSignedIn, onboardingNameDraft, onboardingNameDraftUserId]);

  useEffect(() => {
    if (!isSignedIn || existingName === "") return;
    produceAppState((draft) => {
      const nameDraft = createOnboardingNameDraft(existingName);
      applyOnboardingNameDraft(draft.onboarding, nameDraft);
      draft.local.onboardingNameDraft = nameDraft.name;
      draft.local.onboardingNameDraftUserId = auth?.uid ?? null;
      if (auth?.uid) draft.local.onboardingSessionUserId = auth.uid;
    });
    if (onboardingResumePage && onboardingResumePage !== "signIn") return;
    setEmailDialogOpen(false);
    setDidSignUpWithAccount(!isPersonalUse);
    goToOnboardingPage(
      isPersonalUse ? "personalCredentials" : "chooseTranscription",
    );
  }, [
    auth?.uid,
    existingName,
    isPersonalUse,
    isSignedIn,
    onboardingResumePage,
  ]);

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
    setEmailDialogOpen(true);
  };

  const handleCloseEmailDialog = () => {
    setEmailDialogOpen(false);
  };

  const updateFirstName = (value: string) => {
    produceAppState((draft) => {
      const nameDraft = updateOnboardingFirstName(draft.onboarding, value);
      applyOnboardingNameDraft(draft.onboarding, nameDraft);
      draft.local.onboardingNameDraft = nameDraft.name;
      draft.local.onboardingNameDraftUserId = draft.auth?.uid ?? null;
      if (draft.auth?.uid) draft.local.onboardingSessionUserId = draft.auth.uid;
    });
  };

  const updateLastName = (value: string) => {
    produceAppState((draft) => {
      const nameDraft = updateOnboardingLastName(draft.onboarding, value);
      applyOnboardingNameDraft(draft.onboarding, nameDraft);
      draft.local.onboardingNameDraft = nameDraft.name;
      draft.local.onboardingNameDraftUserId = draft.auth?.uid ?? null;
      if (draft.auth?.uid) draft.local.onboardingSessionUserId = draft.auth.uid;
    });
  };

  const handleFirstNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateFirstName(e.target.value);
  };

  const handleFirstNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    updateFirstName(e.target.value.trim());
  };

  const handleLastNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateLastName(e.target.value);
  };

  const handleLastNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    updateLastName(e.target.value.trim());
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

        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField
            variant="outlined"
            size="small"
            label={<FormattedMessage defaultMessage="First name" />}
            placeholder={intl.formatMessage({ defaultMessage: "John" })}
            value={firstName}
            onChange={handleFirstNameChange}
            onBlur={handleFirstNameBlur}
            required
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
            onMouseEnter={handleLastNameActivate}
            autoComplete="family-name"
            fullWidth
            sx={
              !lastNameEnabled
                ? {
                    "& .MuiInputBase-input": {
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
                "aria-disabled": !lastNameEnabled,
                "data-mausvoice-ignore": "true",
                readOnly: !lastNameEnabled,
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

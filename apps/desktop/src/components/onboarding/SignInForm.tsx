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
  // Tracks whether we've already auto-advanced past signIn for this auth
  // session so pressing Back from chooseTranscription/personalCredentials
  // doesn't immediately push the user forward again.
  const autoAdvancedRef = useRef(false);

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
  const initialized = useAppStore((state) => state.initialized);
  const showEmailButton = useAppStore((state) => getShouldShowEmailForm(state));

  const existingUser = useAppStore((state) => getMyUser(state));
  const existingName = existingUser?.name?.trim() ?? "";

  useEffect(() => {
    if (!isSignedIn) autoAdvancedRef.current = false;
  }, [isSignedIn]);

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
    // Key by (uid, kind, providerName) only — NOT on the draft value itself,
    // because the draft is mutated by user typing and would otherwise
    // re-trigger this effect on every keystroke and clobber input.
    let prefillSource: string;
    if (hasUsableDraft) {
      prefillSource =
        onboardingNameDraftUserId === auth.uid
          ? `owned-draft:${auth.uid}`
          : `ownerless-draft:${auth.uid}`;
    } else {
      prefillSource = `provider:${auth.uid}:${providerName}`;
    }
    if (prefilledNameSource.current === prefillSource) return;
    prefilledNameSource.current = prefillSource;
    produceAppState((draft) => {
      draft.local.onboardingSessionUserId = auth.uid;
      // Foreign (different-UID) draft: clear it and either fall back to the
      // provider name or reset to empty. Clears editable fields together
      // with the persisted draft.
      if (onboardingNameDraft && !draftBelongsToUser) {
        const foreignDraftName = providerName.length > 0 ? providerName : "";
        applyOnboardingNameDraft(
          draft.onboarding,
          createOnboardingNameDraft(foreignDraftName),
        );
        draft.local.onboardingNameDraft = foreignDraftName;
        draft.local.onboardingNameDraftUserId =
          foreignDraftName.length > 0 ? auth.uid : null;
        return;
      }
      if (!prefillName) {
        applyOnboardingNameDraft(
          draft.onboarding,
          createOnboardingNameDraft(""),
        );
        draft.local.onboardingNameDraft = "";
        draft.local.onboardingNameDraftUserId = null;
        return;
      }
      const nameToApply = hasUsableDraft ? onboardingNameDraft : prefillName;
      const nameDraft = createOnboardingNameDraft(nameToApply);
      applyOnboardingNameDraft(draft.onboarding, nameDraft);
      draft.local.onboardingNameDraft = nameDraft.name;
      draft.local.onboardingNameDraftUserId = auth.uid;
    });
  }, [auth, isSignedIn, onboardingNameDraftUserId]);

  useEffect(() => {
    if (!isSignedIn || !initialized || existingName === "") return;
    produceAppState((draft) => {
      const nameDraft = createOnboardingNameDraft(existingName);
      applyOnboardingNameDraft(draft.onboarding, nameDraft);
      draft.local.onboardingNameDraft = nameDraft.name;
      draft.local.onboardingNameDraftUserId = auth?.uid ?? null;
      if (auth?.uid) draft.local.onboardingSessionUserId = auth.uid;
    });
    if (onboardingResumePage && onboardingResumePage !== "signIn") return;
    if (autoAdvancedRef.current) return;
    autoAdvancedRef.current = true;
    setEmailDialogOpen(false);
    setDidSignUpWithAccount(!isPersonalUse);
    goToOnboardingPage(
      isPersonalUse ? "personalCredentials" : "chooseTranscription",
    );
  }, [
    auth?.uid,
    existingName,
    initialized,
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
    const trimmed = e.target.value.trim();
    if (trimmed.length === 0) {
      // Activated but nothing was typed — release the field back to its
      // inactive state so "optional" isn't a one-way latch.
      produceAppState((draft) => {
        draft.onboarding.lastName = "";
        draft.onboarding.lastNameEnabled = false;
        const fn = draft.onboarding.firstName.trim();
        draft.onboarding.name = fn;
        draft.local.onboardingNameDraft = fn;
      });
      return;
    }
    updateLastName(trimmed);
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
          <FormattedMessage
            defaultMessage="Welcome to Maus"
            description="Welcome screen title after sign-in — greets the user"
          />
        </Typography>

        <Typography
          variant="body1"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage
            defaultMessage="What should we call you?"
            description="Welcome screen subtitle prompting for the user's name"
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
                maxLength: 80,
              },
            }}
          />
          {/* Wrap in a Box so hover/click activate the field even while
              it is read-only. readOnly inputs do receive pointer events
              (unlike disabled), but placing onMouseEnter on the wrapper
              guarantees activation before the user moves onto the input
              itself. The field is never HTML-disabled. */}
          <Box
            sx={{ flex: 1, position: "relative" }}
            onMouseEnter={handleLastNameActivate}
          >
            <TextField
              variant="outlined"
              size="small"
              label={<FormattedMessage defaultMessage="Last name" />}
              placeholder={intl.formatMessage({ defaultMessage: "(optional)" })}
              value={lastName}
              onChange={handleLastNameChange}
              onBlur={handleLastNameBlur}
              onFocus={handleLastNameActivate}
              onClick={handleLastNameActivate}
              autoComplete="family-name"
              fullWidth
              sx={
                !lastNameEnabled
                  ? {
                      "& .MuiInputBase-input": {
                        color: "text.disabled",
                        WebkitTextFillColor: "unset",
                        opacity: 0.6,
                        cursor: "pointer",
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
                  maxLength: 80,
                },
              }}
            />
          </Box>
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

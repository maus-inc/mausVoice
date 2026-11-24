import { ArrowForward } from "@mui/icons-material";
import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  goToOnboardingPage,
  setDidSignUpWithAccount,
} from "../../actions/onboarding.actions";
import {
  applyOnboardingNameDraft,
  clearOnboardingLastName,
  createOnboardingNameDraft,
  isOnboardingNameDraftOwnedByAuth,
  updateOnboardingFirstName,
  updateOnboardingLastName,
} from "../../state/onboarding.state";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { isPersonalUseEnabled } from "../../utils/personal-use.utils";
import { OnboardingFormLayout } from "./OnboardingCommon";

type SignInAuth = NonNullable<ReturnType<typeof useAppStore.getState>["auth"]>;
type OnboardingDraft = Parameters<Parameters<typeof produceAppState>[0]>[0];

type NamePrefill = { source: string; apply: (draft: OnboardingDraft) => void };

/**
 * Decides which name a signed-in account starts with. Keyed by
 * (uid, kind, providerName) only, never on the draft value itself, because the
 * draft is mutated by user typing and keying on it would re-run the prefill on
 * every keystroke and clobber input.
 */
const decideNamePrefill = (
  auth: SignInAuth,
  draftValue: string,
  draftUserId: string | null,
): NamePrefill => {
  const draftBelongsToUser = isOnboardingNameDraftOwnedByAuth(
    draftUserId,
    auth.uid,
  );
  const hasUsableDraft = draftBelongsToUser && Boolean(draftValue);
  const providerName = auth.providers.includes("personal")
    ? ""
    : (auth.displayName ?? "");
  const prefillName = hasUsableDraft ? draftValue : providerName;
  const draftSource =
    draftUserId === auth.uid
      ? `owned-draft:${auth.uid}`
      : `ownerless-draft:${auth.uid}`;
  const source = hasUsableDraft
    ? draftSource
    : `provider:${auth.uid}:${providerName}`;

  const apply = (draft: OnboardingDraft) => {
    // Foreign (different-UID) draft: clear it and either fall back to the
    // provider name or reset to empty. Clears editable fields together with the
    // persisted draft.
    if (draftValue && !draftBelongsToUser) {
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
      applyOnboardingNameDraft(draft.onboarding, createOnboardingNameDraft(""));
      draft.local.onboardingNameDraft = "";
      draft.local.onboardingNameDraftUserId = null;
      return;
    }
    const nameDraft = createOnboardingNameDraft(prefillName);
    applyOnboardingNameDraft(draft.onboarding, nameDraft);
    draft.local.onboardingNameDraft = nameDraft.name;
    draft.local.onboardingNameDraftUserId = auth.uid;
  };

  return { source, apply };
};

export const SignInNameStep = () => {
  const intl = useIntl();
  const prefilledNameSource = useRef<string | null>(null);
  // Focus the first-name field explicitly once it has mounted rather than with a
  // DOM `autoFocus` prop: `autoFocus` fires as an attribute and cannot be
  // deferred, so it races anything that moves focus in the same commit. This
  // mirrors ContextMenu's own "focus after commit, not via autoFocus" rule.
  const firstNameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    firstNameRef.current?.focus();
  }, []);

  const auth = useAppStore((state) => state.auth);
  const isPersonalUse = isPersonalUseEnabled();
  const onboardingNameDraft = useAppStore(
    (state) => state.local.onboardingNameDraft,
  );
  const onboardingNameDraftUserId = useAppStore(
    (state) => state.local.onboardingNameDraftUserId,
  );
  const firstName = useAppStore((state) => state.onboarding.firstName);
  const lastName = useAppStore((state) => state.onboarding.lastName);
  const lastNameEnabled = useAppStore(
    (state) => state.onboarding.lastNameEnabled,
  );

  useEffect(() => {
    if (!auth) {
      prefilledNameSource.current = null;
      return;
    }
    const prefill = decideNamePrefill(
      auth,
      onboardingNameDraft,
      onboardingNameDraftUserId,
    );
    if (prefilledNameSource.current === prefill.source) return;
    prefilledNameSource.current = prefill.source;
    produceAppState((draft) => {
      draft.local.onboardingSessionUserId = auth.uid;
      prefill.apply(draft);
    });
  }, [auth, onboardingNameDraft, onboardingNameDraftUserId]);

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
      // inactive state so "optional" isn't a one-way latch. Use the
      // canonical helper so middle-name segments and owner pairing stay
      // consistent with every other name-draft writer.
      produceAppState((draft) => {
        const released = clearOnboardingLastName(draft.onboarding);
        applyOnboardingNameDraft(draft.onboarding, released);
        draft.local.onboardingNameDraft = released.name;
        draft.local.onboardingNameDraftUserId = null;
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

  return (
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
            defaultMessage="Welcome"
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

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
            gap: 2,
          }}
        >
          <TextField
            variant="outlined"
            size="small"
            label={<FormattedMessage defaultMessage="First name" />}
            placeholder={intl.formatMessage({ defaultMessage: "John" })}
            value={firstName}
            onChange={handleFirstNameChange}
            onBlur={handleFirstNameBlur}
            required
            inputRef={firstNameRef}
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
            sx={{ minWidth: 0, position: "relative" }}
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
        </Box>
      </Stack>
    </OnboardingFormLayout>
  );
};

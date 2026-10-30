import { Box, Stack, TextField, Typography } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import rocketImage from "../../assets/4-rocket.png";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  BackButton,
  DualPaneLayout,
  OnboardingContinueButton,
  OnboardingFormHeader,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const UserDetailsForm = () => {
  const intl = useIntl();
  const name = useAppStore((state) => state.onboarding.name);
  const title = useAppStore((state) => state.onboarding.title);
  const company = useAppStore((state) => state.onboarding.company);
  const submitting = useAppStore((state) => state.onboarding.submitting);

  const canContinue = name && !submitting;

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.name = e.target.value;
    });
  };

  const handleNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.name = e.target.value.trim();
    });
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.title = e.target.value;
    });
  };

  const handleTitleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.title = e.target.value.trim();
    });
  };

  const handleCompanyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.company = e.target.value;
    });
  };

  const handleCompanyBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.onboarding.company = e.target.value.trim();
    });
  };

  const handleContinue = () => {
    trackButtonClick("onboarding_user_details_continue");
    goToOnboardingPage("referralSource");
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
          title={<FormattedMessage defaultMessage="Tell us about yourself" />}
          subtitle={
            <FormattedMessage defaultMessage="This information helps personalize your experience." />
          }
        />

        <Stack spacing={2}>
          <TextField
            variant="outlined"
            size="small"
            label={<FormattedMessage defaultMessage="Full name" />}
            placeholder={intl.formatMessage({ defaultMessage: "John Doe" })}
            value={name}
            onChange={handleNameChange}
            onBlur={handleNameBlur}
            autoFocus
            autoComplete="name"
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
            label={
              <span>
                <FormattedMessage defaultMessage="Title" />{" "}
                <Typography
                  component="span"
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    fontWeight: 400,
                    fontSize: "0.7rem",
                  }}
                >
                  <FormattedMessage defaultMessage="(optional)" />
                </Typography>
              </span>
            }
            placeholder={intl.formatMessage({
              defaultMessage: "Vice President",
            })}
            value={title}
            onChange={handleTitleChange}
            onBlur={handleTitleBlur}
            autoComplete="organization-title"
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
            label={
              <span>
                <FormattedMessage defaultMessage="Company" />{" "}
                <Typography
                  component="span"
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    fontWeight: 400,
                    fontSize: "0.7rem",
                  }}
                >
                  <FormattedMessage defaultMessage="(optional)" />
                </Typography>
              </span>
            }
            placeholder={intl.formatMessage({
              defaultMessage: "Acme Inc.",
            })}
            value={company}
            onChange={handleCompanyChange}
            onBlur={handleCompanyBlur}
            autoComplete="organization"
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

  const rightContent = (
    <Box
      component="img"
      src={rocketImage}
      alt="Illustration"
      sx={{ maxWidth: 400, maxHeight: 400 }}
    />
  );

  return <DualPaneLayout left={form} right={rightContent} />;
};

import { ArrowForward, OpenInNew } from "@mui/icons-material";
import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Box,
  Button,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import remoteImage from "../../assets/2-remote.png";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import {
  savePersonalDeepgramApiKey,
  savePersonalGroqApiKey,
} from "../../actions/personal-use.actions";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

const ConsoleLink = ({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}) => (
  <Link
    component="button"
    variant="body2"
    onClick={() => openUrl(url)}
    sx={{ alignSelf: "flex-start" }}
  >
    <Stack direction="row" spacing={0.5} alignItems="center">
      {children}
      <OpenInNew fontSize="inherit" />
    </Stack>
  </Link>
);

export const PersonalCredentialsForm = () => {
  const intl = useIntl();
  const [groqKey, setGroqKey] = useState("");
  const [deepgramKey, setDeepgramKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedGroq = groqKey.trim();
  const trimmedDeepgram = deepgramKey.trim();
  const canSave = Boolean(trimmedGroq || trimmedDeepgram) && !saving;

  const handleSubmit = async () => {
    if (!canSave) {
      return;
    }

    trackButtonClick("onboarding_personal_credentials_save");
    setSaving(true);
    setError(null);

    try {
      if (trimmedGroq) {
        await savePersonalGroqApiKey(trimmedGroq);
      }
      if (trimmedDeepgram) {
        await savePersonalDeepgramApiKey(trimmedDeepgram);
      }
      goToOnboardingPage("userDetails");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : intl.formatMessage({
              defaultMessage: "Unable to save these API keys.",
            }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    trackButtonClick("onboarding_personal_credentials_skip");
    goToOnboardingPage("userDetails");
  };

  const form = (
    <OnboardingFormLayout
      back={<BackButton />}
      actions={
        <Stack direction="row" spacing={1}>
          <Button onClick={handleSkip} disabled={saving}>
            <FormattedMessage defaultMessage="Skip for now" />
          </Button>
          <LoadingButton
            variant="contained"
            endIcon={<ArrowForward />}
            onClick={handleSubmit}
            disabled={!canSave}
            loading={saving}
          >
            <FormattedMessage defaultMessage="Save and continue" />
          </LoadingButton>
        </Stack>
      }
    >
      <Stack spacing={3}>
        <Box>
          <Typography variant="h4" fontWeight={600} pb={1}>
            <FormattedMessage defaultMessage="Connect your API keys" />
          </Typography>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage defaultMessage="Add your Deepgram key for fast streaming transcription and your Groq key for AI post-processing. Keys are encrypted and stored locally, and you can change them any time in Settings." />
          </Typography>
        </Box>

        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            variant="outlined"
            size="small"
            type="password"
            label={<FormattedMessage defaultMessage="Deepgram API key" />}
            value={deepgramKey}
            onChange={(event) => setDeepgramKey(event.target.value)}
            autoFocus
            autoComplete="off"
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: {
                "data-voquill-ignore": "true",
              },
            }}
          />
          <ConsoleLink url="https://console.deepgram.com/">
            <FormattedMessage defaultMessage="Open Deepgram API keys" />
          </ConsoleLink>

          <TextField
            variant="outlined"
            size="small"
            type="password"
            label={<FormattedMessage defaultMessage="Groq API key" />}
            placeholder={intl.formatMessage({ defaultMessage: "gsk_..." })}
            value={groqKey}
            onChange={(event) => setGroqKey(event.target.value)}
            autoComplete="off"
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: {
                "data-voquill-ignore": "true",
              },
            }}
          />
          <ConsoleLink url="https://console.groq.com/keys">
            <FormattedMessage defaultMessage="Open Groq API keys" />
          </ConsoleLink>
        </Stack>
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

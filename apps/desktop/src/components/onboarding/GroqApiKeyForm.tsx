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
import { savePersonalGroqApiKey } from "../../actions/personal-use.actions";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const GroqApiKeyForm = () => {
  const intl = useIntl();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedApiKey = apiKey.trim();
  const canSave = Boolean(trimmedApiKey) && !saving;

  const handleSubmit = async () => {
    if (!canSave) {
      return;
    }

    trackButtonClick("onboarding_groq_api_key_save");
    setSaving(true);
    setError(null);

    try {
      await savePersonalGroqApiKey(trimmedApiKey);
      goToOnboardingPage("userDetails");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : intl.formatMessage({
              defaultMessage: "Unable to save this Groq API key.",
            }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    trackButtonClick("onboarding_groq_api_key_skip");
    goToOnboardingPage("chooseTranscription");
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
            <FormattedMessage defaultMessage="Connect Groq" />
          </Typography>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage defaultMessage="Add your Groq API key to use fast cloud transcription and AI post-processing. The key is encrypted and stored locally in this app." />
          </Typography>
        </Box>

        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            variant="outlined"
            size="small"
            type="password"
            label={<FormattedMessage defaultMessage="Groq API key" />}
            placeholder={intl.formatMessage({ defaultMessage: "gsk_..." })}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoFocus
            autoComplete="off"
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: {
                "data-voquill-ignore": "true",
              },
            }}
          />

          <Link
            component="button"
            variant="body2"
            onClick={() => openUrl("https://console.groq.com/keys")}
            sx={{ alignSelf: "flex-start" }}
          >
            <Stack direction="row" spacing={0.5} alignItems="center">
              <FormattedMessage defaultMessage="Open Groq API keys" />
              <OpenInNew fontSize="inherit" />
            </Stack>
          </Link>
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

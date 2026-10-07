import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { openExternalUrl } from "../../utils/open-url.utils";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  savePersonalDeepgramApiKey,
  savePersonalGroqApiKey,
} from "../../actions/personal-use.actions";
import { useAppStore } from "../../store";
import { findPersonalApiKey } from "../../utils/personal-use.utils";

export type PersonalApiKeyProvider = "groq" | "deepgram";

type ProviderCopy = {
  title: React.ReactNode;
  description: React.ReactNode;
  consoleUrl: string;
  consoleLabel: React.ReactNode;
  placeholder?: string;
  savedMessage: string;
  save: (key: string) => Promise<unknown>;
};

const PROVIDER_COPY: Record<PersonalApiKeyProvider, ProviderCopy> = {
  deepgram: {
    title: <FormattedMessage defaultMessage="Deepgram API key" />,
    description: (
      <FormattedMessage defaultMessage="Used for fast streaming transcription. Encrypted and stored on this computer before it is saved." />
    ),
    consoleUrl: "https://console.deepgram.com/",
    consoleLabel: <FormattedMessage defaultMessage="Open Deepgram API keys" />,
    savedMessage: "Deepgram API key saved",
    save: savePersonalDeepgramApiKey,
  },
  groq: {
    title: <FormattedMessage defaultMessage="Groq API key" />,
    description: (
      <FormattedMessage defaultMessage="Used for transcription and AI post processing. Encrypted and stored on this computer before it is saved." />
    ),
    consoleUrl: "https://console.groq.com/keys",
    consoleLabel: <FormattedMessage defaultMessage="Open Groq API keys" />,
    placeholder: "gsk_...",
    savedMessage: "Groq API key saved",
    save: savePersonalGroqApiKey,
  },
};

/**
 * The one form behind both personal API keys.
 *
 * The two providers need the same three pieces of state and the same four
 * controls, and the page used to carry a copy of each. The provider decides the
 * copy, the console link and the action; everything else is shared.
 */
export const PersonalApiKeyDialog = ({
  provider,
  open,
  onClose,
}: {
  provider: PersonalApiKeyProvider;
  open: boolean;
  onClose: () => void;
}) => {
  const intl = useIntl();
  const copy = PROVIDER_COPY[provider];
  const currentKey = useAppStore((state) =>
    findPersonalApiKey(state.settings.apiKeys, provider),
  );
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setErrorMessage(null);
      setSaving(false);
      // The field is the dialog's whole purpose, so it takes the focus. Set
      // here rather than as an `autoFocus` attribute, which fires as markup and
      // cannot be deferred; this is the repo's established rule for dialogs.
      keyRef.current?.focus();
    }
  }, [open, provider]);

  const close = () => {
    if (!saving) {
      onClose();
    }
  };

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || saving) {
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    try {
      await copy.save(trimmed);
      showSnackbar(copy.savedMessage, { mode: "success" });
      onClose();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : intl.formatMessage({
              defaultMessage: "Could not save the API key.",
            });
      setErrorMessage(message);
      showErrorSnackbar(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>{copy.title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {copy.description}
          </Typography>
          {currentKey?.keySuffix && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              <FormattedMessage
                defaultMessage="Current key ends with {suffix}."
                values={{ suffix: currentKey.keySuffix }}
              />
            </Typography>
          )}
          {errorMessage && <Alert severity="error">{errorMessage}</Alert>}
          <TextField
            inputRef={keyRef}
            fullWidth
            size="small"
            type="password"
            label={<FormattedMessage defaultMessage="API key" />}
            placeholder={copy.placeholder}
            value={value}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { "data-mausvoice-ignore": "true" },
            }}
          />
          <Link
            component="button"
            type="button"
            variant="body2"
            onClick={() => openExternalUrl(copy.consoleUrl)}
            sx={{ alignSelf: "flex-start" }}
          >
            {copy.consoleLabel}
          </Link>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={saving}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={!value.trim() || saving}
        >
          {saving ? (
            <FormattedMessage defaultMessage="Saving..." />
          ) : (
            <FormattedMessage defaultMessage="Save" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

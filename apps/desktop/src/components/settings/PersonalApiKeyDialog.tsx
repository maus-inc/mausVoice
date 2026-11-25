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
import {
  deepgramTestIntegration,
  groqTestIntegration,
} from "@maus-inc/voice-ai";
import { useEffect, useRef, useState } from "react";
import {
  defineMessage,
  FormattedMessage,
  useIntl,
  type MessageDescriptor,
} from "react-intl";
import { openExternalUrl } from "../../utils/open-url.utils";
import { showSnackbar } from "../../actions/app.actions";
import {
  savePersonalDeepgramApiKey,
  savePersonalGroqApiKey,
} from "../../actions/personal-use.actions";
import { useAppStore } from "../../store";
import {
  apiKeyNeedsAttention,
  getApiKeyCredentialIssue,
} from "../../utils/api-key.utils";
import { findPersonalApiKey } from "../../utils/personal-use.utils";
import { secureFetch } from "../../utils/secure-fetch.utils";
import { ProviderLogo } from "../common/provider-logos/ProviderLogo";

export type PersonalApiKeyProvider = "groq" | "deepgram";

type ProviderCopy = {
  title: React.ReactNode;
  description: React.ReactNode;
  consoleUrl: string;
  consoleLabel: React.ReactNode;
  placeholder?: string;
  /** A descriptor rather than a sentence: the snackbar has to speak the
   *  person's locale, and this table is built once at module scope, before
   *  there is an `intl` to ask. */
  savedMessage: MessageDescriptor;
  save: (key: string) => Promise<unknown>;
  testKey: (key: string) => Promise<boolean>;
};

const PROVIDER_COPY: Record<PersonalApiKeyProvider, ProviderCopy> = {
  deepgram: {
    title: <FormattedMessage defaultMessage="Deepgram API key" />,
    description: (
      <FormattedMessage defaultMessage="Used for fast streaming transcription. Encrypted and stored on this computer before it is saved." />
    ),
    consoleUrl: "https://console.deepgram.com/",
    consoleLabel: <FormattedMessage defaultMessage="Open Deepgram API keys" />,
    savedMessage: defineMessage({
      defaultMessage: "Deepgram API key saved",
    }),
    save: savePersonalDeepgramApiKey,
    testKey: (apiKey) => deepgramTestIntegration({ apiKey }),
  },
  groq: {
    title: <FormattedMessage defaultMessage="Groq API key" />,
    description: (
      <FormattedMessage defaultMessage="Used for transcription and AI post processing. Encrypted and stored on this computer before it is saved." />
    ),
    consoleUrl: "https://console.groq.com/keys",
    consoleLabel: <FormattedMessage defaultMessage="Open Groq API keys" />,
    placeholder: "gsk_...",
    savedMessage: defineMessage({
      defaultMessage: "Groq API key saved",
    }),
    save: savePersonalGroqApiKey,
    testKey: (apiKey) =>
      groqTestIntegration({ apiKey, customFetch: secureFetch }),
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
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<"success" | "error" | null>(
    null,
  );
  const saveInFlight = useRef(false);
  const testInFlight = useRef(false);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setErrorMessage(null);
      setSaving(false);
      setTesting(false);
      setTestOutcome(null);
    }
  }, [open, provider]);

  const close = () => {
    if (!saving && !saveInFlight.current && !testing && !testInFlight.current) {
      onClose();
    }
  };

  const handleTest = async () => {
    const trimmed = value.trim();
    if (!trimmed || saving || testing || testInFlight.current) {
      return;
    }

    testInFlight.current = true;
    setTesting(true);
    setTestOutcome(null);
    setErrorMessage(null);
    try {
      const ok = await copy.testKey(trimmed);
      setTestOutcome(ok ? "success" : "error");
    } catch {
      setTestOutcome("error");
    } finally {
      testInFlight.current = false;
      setTesting(false);
    }
  };

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || saving || saveInFlight.current || testing) {
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    setErrorMessage(null);
    setTestOutcome(null);
    try {
      await copy.save(trimmed);
      showSnackbar(intl.formatMessage(copy.savedMessage), {
        mode: "success",
      });
      onClose();
    } catch {
      setErrorMessage(
        intl.formatMessage({ defaultMessage: "Could not save the API key." }),
      );
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const currentKeyIssue = getApiKeyCredentialIssue(currentKey);
  const currentKeyNeedsAttention = apiKeyNeedsAttention(currentKey);

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth="xs"
      fullWidth
      slotProps={{
        // The field is the dialog's whole purpose, so it takes the focus once
        // the dialog has entered. Not from the open effect above: when that
        // effect runs the dialog's content is not mounted yet — the ref is
        // still null — and MUI's focus trap is left holding the paper. Not as
        // `autoFocus` either, which fires as markup and cannot be deferred;
        // this is the repo's established rule for dialogs.
        transition: {
          onEntered: () => {
            const input = keyRef.current;
            input?.focus({ preventScroll: true });
            const content = input?.closest<HTMLElement>(
              ".MuiDialogContent-root",
            );
            if (input && content) {
              const overflow =
                input.getBoundingClientRect().bottom -
                content.getBoundingClientRect().bottom;
              if (overflow > 0) content.scrollTop += overflow + 8;
            }
          },
        },
      }}
    >
      <DialogTitle>
        {/* The mark is the provider's identity here, and the title beside it
            already names the provider — so it is decorative, not a second
            label for the dialog. */}
        <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <ProviderLogo provider={provider} size={20} />
          {copy.title}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {copy.description}
          </Typography>
          {currentKeyNeedsAttention && (
            <Alert severity="warning" sx={{ boxShadow: "none" }}>
              {currentKeyIssue === "legacy_encryption" ? (
                <FormattedMessage defaultMessage="This key was imported from Voquill's older encryption format and could not be unlocked. Enter your key again to re-encrypt it with mausVoice." />
              ) : currentKeyIssue === "decryption_failed" ? (
                <FormattedMessage defaultMessage="The saved key could not be decrypted on this computer. Enter your key again to replace it." />
              ) : (
                <FormattedMessage defaultMessage="The saved key configuration is incomplete or invalid. Enter a valid key to continue." />
              )}
            </Alert>
          )}
          {currentKey?.keySuffix && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              <FormattedMessage
                defaultMessage="Current key ends with {suffix}."
                values={{ suffix: currentKey.keySuffix }}
              />
            </Typography>
          )}
          {errorMessage && <Alert severity="error">{errorMessage}</Alert>}
          {testOutcome === "success" && (
            <Alert severity="success" role="status">
              <FormattedMessage defaultMessage="Key verified." />
            </Alert>
          )}
          {testOutcome === "error" && (
            <Alert severity="error" role="status">
              <FormattedMessage defaultMessage="Could not verify this key. Check the key and try again." />
            </Alert>
          )}
          <TextField
            inputRef={keyRef}
            fullWidth
            size="small"
            type="password"
            label={<FormattedMessage defaultMessage="API key" />}
            placeholder={copy.placeholder}
            value={value}
            disabled={saving || testing}
            onChange={(event) => {
              setValue(event.target.value);
              if (testOutcome !== null) setTestOutcome(null);
            }}
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
            onClick={() =>
              openExternalUrl(copy.consoleUrl, "the provider console")
            }
            sx={{ alignSelf: "flex-start" }}
          >
            {copy.consoleLabel}
          </Link>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => void handleTest()}
          disabled={!value.trim() || saving || testing}
          aria-busy={testing || undefined}
          sx={{ mr: "auto" }}
        >
          {testing ? (
            <FormattedMessage defaultMessage="Testing..." />
          ) : (
            <FormattedMessage defaultMessage="Test key" />
          )}
        </Button>
        <Button onClick={close} disabled={saving || testing}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={!value.trim() || saving || testing}
          aria-busy={saving || undefined}
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

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
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState, type ReactNode } from "react";
import { FormattedMessage } from "react-intl";
import { showSnackbar } from "../../actions/app.actions";

export const usePersonalApiKeyDialog = (
  saveKey: (key: string) => Promise<unknown>,
  providerName: string,
) => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const show = () => {
    if (savingRef.current) return;
    setInput("");
    setError(null);
    setOpen(true);
  };
  const close = () => {
    if (!savingRef.current) setOpen(false);
  };
  const save = async () => {
    const trimmed = input.trim();
    if (!trimmed || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await saveKey(trimmed);
      showSnackbar(`${providerName} API key saved`, { mode: "success" });
      setInput("");
      setOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `Failed to save ${providerName} API key.`,
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return { open, input, setInput, saving, error, show, close, save };
};

export const PersonalApiKeyDialog = ({
  state,
  suffix,
  title,
  description,
  placeholder,
  keyUrl,
  linkLabel,
}: {
  state: ReturnType<typeof usePersonalApiKeyDialog>;
  suffix: string | null | undefined;
  title: ReactNode;
  description: ReactNode;
  placeholder?: string;
  keyUrl: string;
  linkLabel: ReactNode;
}) => (
  <Dialog open={state.open} onClose={state.close} maxWidth="xs" fullWidth>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent dividers>
      <Stack spacing={2}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {description}
        </Typography>
        {suffix && (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            <FormattedMessage
              defaultMessage="Current key ends with {suffix}."
              values={{ suffix }}
            />
          </Typography>
        )}
        {state.error && <Alert severity="error">{state.error}</Alert>}
        <TextField
          autoFocus
          fullWidth
          size="small"
          type="password"
          label={<FormattedMessage defaultMessage="API key" />}
          placeholder={placeholder}
          value={state.input}
          disabled={state.saving}
          onChange={(event) => state.setInput(event.target.value)}
          autoComplete="off"
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: { "data-mausvoice-ignore": "true" },
          }}
        />
        <Link
          component="button"
          variant="body2"
          onClick={() => openUrl(keyUrl)}
          sx={{ alignSelf: "flex-start" }}
        >
          {linkLabel}
        </Link>
      </Stack>
    </DialogContent>
    <DialogActions>
      <Button onClick={state.close} disabled={state.saving}>
        <FormattedMessage defaultMessage="Cancel" />
      </Button>
      <Button
        variant="contained"
        onClick={state.save}
        disabled={!state.input.trim() || state.saving}
      >
        {state.saving ? (
          <FormattedMessage defaultMessage="Saving..." />
        ) : (
          <FormattedMessage defaultMessage="Save" />
        )}
      </Button>
    </DialogActions>
  </Dialog>
);

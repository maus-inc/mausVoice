import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { ReleaseNotesMarkdown } from "./ReleaseNotesMarkdown";
import {
  ChangelogEntry,
  ChangelogFetchError,
  fetchChangelog,
} from "../../actions/changelog.actions";

const ChangelogErrorMessage = ({ error }: { error: unknown }) => {
  if (error instanceof ChangelogFetchError) {
    switch (error.code) {
      case "network":
        return (
          <FormattedMessage defaultMessage="Could not reach the release history." />
        );
      case "http":
        return (
          <FormattedMessage
            defaultMessage="The release history returned status {status}."
            values={{ status: error.status }}
          />
        );
      case "invalid-response":
        return (
          <FormattedMessage defaultMessage="The release history had an unexpected response." />
        );
    }
  }
  return <FormattedMessage defaultMessage="Could not load the changelog." />;
};

const normalizeVersion = (value: string): string =>
  value.replace(/^mausvoice[\s\-_]*v?/i, "").trim();

const formatReleaseDate = (isoDate: string | null) => {
  if (!isoDate) {
    return null;
  }
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(parsed);
};

const ReleaseRow = ({
  entry,
  installed,
}: {
  entry: ChangelogEntry;
  installed: boolean;
}) => {
  const date = formatReleaseDate(entry.date);
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {entry.version}
        </Typography>
        <Chip
          size="small"
          label={
            entry.prerelease ? (
              <FormattedMessage defaultMessage="Beta" />
            ) : (
              <FormattedMessage defaultMessage="Stable" />
            )
          }
          color={entry.prerelease ? "warning" : "success"}
          variant="outlined"
        />
        {installed && (
          <Chip
            size="small"
            label={<FormattedMessage defaultMessage="Installed" />}
            color="primary"
          />
        )}
        {date && (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", ml: "auto" }}
          >
            {date}
          </Typography>
        )}
      </Stack>
      {entry.body ? (
        <ReleaseNotesMarkdown>{entry.body}</ReleaseNotesMarkdown>
      ) : (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          <FormattedMessage defaultMessage="No notes for this release." />
        </Typography>
      )}
      <Button
        size="small"
        variant="text"
        sx={{ mt: 0.5, px: 0 }}
        onClick={() => void openUrl(entry.url)}
      >
        <FormattedMessage defaultMessage="View on GitHub" />
      </Button>
    </Box>
  );
};

export const ChangelogDialog = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    setError(null);
    getVersion()
      .then((version) => {
        if (!controller.signal.aborted) {
          setInstalledVersion(version);
        }
      })
      .catch(() => undefined);
    fetchChangelog(controller.signal).then(
      (rows) => {
        if (controller.signal.aborted) {
          return;
        }
        setEntries(rows);
        setStatus("done");
      },
      (fetchError: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setError(fetchError);
        setStatus("error");
      },
    );
    return () => controller.abort();
  }, [open, nonce]);

  const handleRetry = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  const installed = normalizeVersion(installedVersion ?? "");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      fullScreen={fullScreen}
      sx={{ zIndex: 10000 }}
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="What's new" />
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 280 }}>
        {status === "loading" && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 4 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="Loading release history..." />
            </Typography>
          </Box>
        )}
        {status === "error" && (
          <Stack spacing={2} sx={{ py: 2 }}>
            <Alert severity="error">
              <ChangelogErrorMessage error={error} />
            </Alert>
            <Box>
              <Button variant="outlined" size="small" onClick={handleRetry}>
                <FormattedMessage defaultMessage="Retry" />
              </Button>
            </Box>
          </Stack>
        )}
        {status === "done" &&
          (entries.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              <FormattedMessage defaultMessage="No releases found yet." />
            </Typography>
          ) : (
            <Stack spacing={2} divider={<Divider flexItem />} sx={{ pt: 1 }}>
              {entries.map((entry) => (
                <ReleaseRow
                  key={entry.tag}
                  entry={entry}
                  installed={
                    installed.length > 0 &&
                    normalizeVersion(entry.tag) === installed
                  }
                />
              ))}
            </Stack>
          ))}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="text" onClick={onClose}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};

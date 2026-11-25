import type {
  VoquillMigrationIssue,
  VoquillMigrationPhaseStatus,
  VoquillMigrationReport,
} from "@maus-inc/desktop-native-apis";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button, CircularProgress } from "@mui/material";
import { useCallback } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { useNavigate } from "react-router-dom";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { runVoquillMigrationRetry } from "../../actions/voquill-migration.actions";
import { settingsPagePath } from "../settings/settings-routes";

export const useVoquillMigrationRetry = () => {
  const intl = useIntl();
  return useCallback(async () => {
    try {
      const updated = await runVoquillMigrationRetry();
      if (updated.status === "completed") {
        showSnackbar(
          intl.formatMessage({ defaultMessage: "Voquill import completed." }),
          { mode: "success" },
        );
      } else if (updated.status === "skipped_existing_profile") {
        showSnackbar(
          intl.formatMessage({
            defaultMessage: "Kept your existing mausVoice profile.",
          }),
          { mode: "info" },
        );
      }
    } catch {
      showErrorSnackbar(
        intl.formatMessage({
          defaultMessage: "Could not retry the Voquill import.",
        }),
      );
    }
  }, [intl]);
};

export const VoquillMigrationReviewKeysButton = ({
  variant,
}: {
  variant: "contained" | "outlined";
}) => {
  const navigate = useNavigate();
  return (
    <Button
      size="small"
      variant={variant}
      endIcon={<ArrowRight size={14} strokeWidth={1.9} />}
      onClick={() => navigate(settingsPagePath("ai-models"))}
    >
      <FormattedMessage defaultMessage="Review API keys" />
    </Button>
  );
};

export const VoquillMigrationRetryButton = ({
  variant,
  isPartial,
  retrying,
  disabled,
  onRetry,
}: {
  variant: "contained" | "outlined";
  isPartial: boolean;
  retrying: boolean;
  disabled?: boolean;
  onRetry: () => void;
}) => (
  <Button
    size="small"
    variant={variant}
    onClick={onRetry}
    disabled={disabled || retrying}
    startIcon={
      retrying ? (
        <CircularProgress size={14} color="inherit" />
      ) : (
        <RefreshCw size={14} strokeWidth={1.9} />
      )
    }
  >
    {isPartial ? (
      <FormattedMessage defaultMessage="Retry missing files" />
    ) : (
      <FormattedMessage defaultMessage="Retry import" />
    )}
  </Button>
);

export const formatVoquillMigrationCountsSummary = (
  intl: IntlShape,
  report: VoquillMigrationReport,
): string | null => {
  const parts: string[] = [];
  const { counts } = report;

  if (counts.transcriptions > 0) {
    parts.push(
      intl.formatMessage(
        {
          defaultMessage:
            "{count, plural, one {# transcription} other {# transcriptions}}",
        },
        { count: counts.transcriptions },
      ),
    );
  }
  if (counts.dictionaryTerms > 0) {
    parts.push(
      intl.formatMessage(
        {
          defaultMessage:
            "{count, plural, one {# dictionary term} other {# dictionary terms}}",
        },
        { count: counts.dictionaryTerms },
      ),
    );
  }
  if (counts.hotkeys > 0) {
    parts.push(
      intl.formatMessage(
        {
          defaultMessage:
            "{count, plural, one {# shortcut} other {# shortcuts}}",
        },
        { count: counts.hotkeys },
      ),
    );
  }
  if (counts.tones > 0) {
    parts.push(
      intl.formatMessage(
        {
          defaultMessage:
            "{count, plural, one {# writing style} other {# writing styles}}",
        },
        { count: counts.tones },
      ),
    );
  }
  if (counts.appTargets > 0) {
    parts.push(
      intl.formatMessage(
        {
          defaultMessage:
            "{count, plural, one {# app rule} other {# app rules}}",
        },
        { count: counts.appTargets },
      ),
    );
  }
  if (counts.localModelsMigrated > 0) {
    parts.push(
      intl.formatMessage(
        {
          defaultMessage:
            "{count, plural, one {# local model} other {# local models}}",
        },
        { count: counts.localModelsMigrated },
      ),
    );
  }
  if (counts.audioFilesMigrated > 0) {
    parts.push(
      intl.formatMessage(
        {
          defaultMessage:
            "{count, plural, one {# audio file} other {# audio files}}",
        },
        { count: counts.audioFilesMigrated },
      ),
    );
  }

  return parts.length > 0 ? parts.join(" · ") : null;
};

export const formatVoquillPhaseLabel = (
  intl: IntlShape,
  phase: VoquillMigrationPhaseStatus,
): string => {
  switch (phase) {
    case "migrated":
      return intl.formatMessage({ defaultMessage: "Imported" });
    case "partial":
      return intl.formatMessage({ defaultMessage: "Partially imported" });
    case "failed":
      return intl.formatMessage({ defaultMessage: "Failed" });
    case "skipped":
      return intl.formatMessage({ defaultMessage: "Skipped" });
    case "pending":
      return intl.formatMessage({ defaultMessage: "Pending" });
    case "not_found":
      return intl.formatMessage({ defaultMessage: "None found" });
  }
};

export const formatVoquillIssueSummary = (
  intl: IntlShape,
  issue: VoquillMigrationIssue,
): string => {
  switch (issue.code) {
    case "existing_profile_conflict":
      return intl.formatMessage({
        defaultMessage:
          "Your current mausVoice profile already has saved data, so the Voquill profile was left untouched.",
      });
    case "corrupt_database":
      return intl.formatMessage({
        defaultMessage:
          "The Voquill database file failed an integrity check and could not be imported.",
      });
    case "incompatible_schema":
      return intl.formatMessage({
        defaultMessage:
          "The Voquill database uses a newer schema than this version of mausVoice supports.",
      });
    case "database_copy_failed":
    case "wal_copy_failed":
    case "journal_copy_failed":
      return intl.formatMessage({
        defaultMessage:
          "The Voquill database could not be copied. Close Voquill if it is still open, then try again.",
      });
    case "interrupted_previous_attempt":
      return intl.formatMessage({
        defaultMessage:
          "A previous Voquill import attempt was interrupted before finishing.",
      });
    case "models_copy_incomplete":
      return intl.formatMessage({
        defaultMessage:
          "Some local transcription model files could not be copied.",
      });
    case "audio_copy_incomplete":
      return intl.formatMessage({
        defaultMessage: "Some saved audio recordings could not be copied.",
      });
    case "storage_copy_incomplete":
      return intl.formatMessage({
        defaultMessage: "Some app icon assets could not be copied.",
      });
    default:
      return intl.formatMessage({
        defaultMessage:
          "Part of the Voquill import could not be completed. Your original Voquill files were not modified.",
      });
  }
};

import { ArrowRight, RefreshCw } from "lucide-react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { runVoquillMigrationRetry } from "../../actions/voquill-migration.actions";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { useAppStore } from "../../store";
import { SettingRow } from "./SettingRow";
import { settingsPagePath } from "./settings-routes";
import {
  formatVoquillIssueSummary,
  formatVoquillMigrationCountsSummary,
  formatVoquillPhaseLabel,
} from "../migration/voquill-migration-copy";

/**
 * Persistent, always-discoverable Voquill migration report in Settings ->
 * Privacy & Data. Remains accessible after the one-time Home banner is
 * dismissed, and offers truthful phase status, API key review links, and safe
 * retry controls.
 */
export const VoquillMigrationSettingsSection = () => {
  const intl = useIntl();
  const navigate = useNavigate();
  const report = useAppStore((state) => state.voquillMigration.report);
  const retrying = useAppStore((state) => state.voquillMigration.retrying);

  if (!report || !report.legacyDetected || report.status === "not_needed") {
    return null;
  }

  const needsKeyAttention = report.counts.providersNeedingAttention > 0;
  const hasRemovedCloudModes = report.removedModesReset.length > 0;

  const statusBadge = (() => {
    if (report.status === "failed") {
      return {
        color: "error" as const,
        label: <FormattedMessage defaultMessage="Failed" />,
      };
    }
    if (report.status === "partial") {
      return {
        color: "warning" as const,
        label: <FormattedMessage defaultMessage="Partial" />,
      };
    }
    if (report.status === "skipped_existing_profile") {
      return {
        color: "default" as const,
        label: <FormattedMessage defaultMessage="Kept existing profile" />,
      };
    }
    if (needsKeyAttention || hasRemovedCloudModes) {
      return {
        color: "warning" as const,
        label: <FormattedMessage defaultMessage="Action needed" />,
      };
    }
    return {
      color: "success" as const,
      label: <FormattedMessage defaultMessage="Completed" />,
    };
  })();

  const countsSummary = formatVoquillMigrationCountsSummary(intl, report);

  const handleRetry = async () => {
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
  };

  return (
    <SettingRow
      settingKey="voquill_migration"
      title={
        <Stack
          direction="row"
          spacing={1.5}
          sx={{
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <Box component="span">
            <FormattedMessage defaultMessage="Voquill migration" />
          </Box>
          <Chip
            size="small"
            color={statusBadge.color}
            label={statusBadge.label}
          />
        </Stack>
      }
      description={
        <Stack spacing={1.25} sx={{ mt: 0.75 }}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {report.status === "skipped_existing_profile" ? (
              <FormattedMessage defaultMessage="An older Voquill profile was found on this computer, but your existing mausVoice profile was kept untouched." />
            ) : report.status === "failed" ? (
              <FormattedMessage defaultMessage="mausVoice found a Voquill profile but could not finish importing it. Your original Voquill files were not modified." />
            ) : countsSummary ? (
              <Box component="span" sx={{ fontVariantNumeric: "tabular-nums" }}>
                {countsSummary}
              </Box>
            ) : (
              <FormattedMessage defaultMessage="Your Voquill profile was imported into mausVoice." />
            )}
          </Typography>

          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: "wrap" }}
          >
            <Chip
              size="small"
              variant="outlined"
              label={intl.formatMessage(
                { defaultMessage: "Database: {status}" },
                {
                  status: formatVoquillPhaseLabel(intl, report.databasePhase),
                },
              )}
            />
            {report.modelsPhase !== "not_found" && (
              <Chip
                size="small"
                variant="outlined"
                label={intl.formatMessage(
                  { defaultMessage: "Models: {status}" },
                  {
                    status: formatVoquillPhaseLabel(intl, report.modelsPhase),
                  },
                )}
              />
            )}
            {report.audioPhase !== "not_found" && (
              <Chip
                size="small"
                variant="outlined"
                label={intl.formatMessage(
                  { defaultMessage: "Audio: {status}" },
                  {
                    status: formatVoquillPhaseLabel(intl, report.audioPhase),
                  },
                )}
              />
            )}
            {report.storagePhase !== "not_found" && (
              <Chip
                size="small"
                variant="outlined"
                label={intl.formatMessage(
                  { defaultMessage: "Assets: {status}" },
                  {
                    status: formatVoquillPhaseLabel(intl, report.storagePhase),
                  },
                )}
              />
            )}
          </Stack>

          {needsKeyAttention && (
            <Alert severity="warning" sx={{ py: 0.5, boxShadow: "none" }}>
              <FormattedMessage
                defaultMessage="{count, plural, one {# saved API key could not be unlocked from Voquill's older encryption format and needs to be re-entered.} other {# saved API keys could not be unlocked from Voquill's older encryption format and need to be re-entered.}}"
                values={{ count: report.counts.providersNeedingAttention }}
              />
            </Alert>
          )}

          {hasRemovedCloudModes && (
            <Alert severity="info" sx={{ py: 0.5, boxShadow: "none" }}>
              <FormattedMessage defaultMessage="Previous Voquill Cloud settings were reset to local or off because hosted cloud mode is not included in mausVoice." />
            </Alert>
          )}

          {report.issues.length > 0 && (
            <Stack spacing={0.5}>
              {report.issues.map((issue, index) => (
                <Typography
                  key={`${issue.category}-${issue.code}-${index}`}
                  variant="caption"
                  sx={{
                    color:
                      report.status === "failed"
                        ? "error.main"
                        : "text.secondary",
                  }}
                >
                  {formatVoquillIssueSummary(intl, issue)}
                </Typography>
              ))}
            </Stack>
          )}

          {report.legacySourcePreserved && (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              <FormattedMessage defaultMessage="Your original Voquill files were left untouched." />
            </Typography>
          )}

          {(needsKeyAttention || hasRemovedCloudModes || report.canRetry) && (
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap", pt: 0.25 }}
            >
              {(needsKeyAttention || hasRemovedCloudModes) && (
                <Button
                  size="small"
                  variant="outlined"
                  endIcon={<ArrowRight size={14} strokeWidth={1.9} />}
                  onClick={() => navigate(settingsPagePath("ai-models"))}
                >
                  <FormattedMessage defaultMessage="Review API keys" />
                </Button>
              )}
              {report.canRetry && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => void handleRetry()}
                  disabled={retrying}
                  startIcon={
                    retrying ? (
                      <CircularProgress size={14} color="inherit" />
                    ) : (
                      <RefreshCw size={14} strokeWidth={1.9} />
                    )
                  }
                >
                  {report.status === "partial" ? (
                    <FormattedMessage defaultMessage="Retry missing files" />
                  ) : (
                    <FormattedMessage defaultMessage="Retry import" />
                  )}
                </Button>
              )}
            </Stack>
          )}
        </Stack>
      }
    />
  );
};

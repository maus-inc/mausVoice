import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  RefreshCw,
  X,
} from "lucide-react";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import {
  dismissVoquillMigration,
  runVoquillMigrationRetry,
} from "../../actions/voquill-migration.actions";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { useAppStore } from "../../store";
import { settingAnchorId, settingsPagePath } from "../settings/settings-routes";
import {
  formatVoquillIssueSummary,
  formatVoquillMigrationCountsSummary,
} from "./voquill-migration-copy";

/**
 * One-time, dismissible Voquill-to-mausVoice migration summary card on Home.
 *
 * Only shown when a legacy Voquill profile was detected and the user has not
 * yet dismissed the banner. Dismissing hides this card permanently while the
 * full phase-by-phase report stays inspectable in Settings -> Privacy & Data.
 */
export const VoquillMigrationBanner = () => {
  const intl = useIntl();
  const navigate = useNavigate();
  const report = useAppStore((state) => state.voquillMigration.report);
  const retrying = useAppStore((state) => state.voquillMigration.retrying);
  const dismissing = useAppStore((state) => state.voquillMigration.dismissing);

  if (
    !report ||
    !report.legacyDetected ||
    report.status === "not_needed" ||
    report.dismissedAt !== null
  ) {
    return null;
  }

  const needsKeyAttention = report.counts.providersNeedingAttention > 0;
  const hasRemovedCloudModes = report.removedModesReset.length > 0;
  const isFailure = report.status === "failed";
  const isPartial = report.status === "partial";
  const isSkipped = report.status === "skipped_existing_profile";
  const isAttention =
    isFailure || isPartial || needsKeyAttention || hasRemovedCloudModes;

  const accentColor = isFailure
    ? "error.main"
    : isAttention
      ? "warning.main"
      : isSkipped
        ? "info.main"
        : "success.main";

  const countsSummary = formatVoquillMigrationCountsSummary(intl, report);
  const primaryIssue = report.issues[0]
    ? formatVoquillIssueSummary(intl, report.issues[0])
    : null;

  const title = (() => {
    if (isFailure) {
      return (
        <FormattedMessage defaultMessage="Could not import your Voquill data" />
      );
    }
    if (isPartial) {
      return (
        <FormattedMessage defaultMessage="Imported from Voquill — some files were skipped" />
      );
    }
    if (isSkipped) {
      return (
        <FormattedMessage defaultMessage="Existing mausVoice profile kept" />
      );
    }
    if (needsKeyAttention || hasRemovedCloudModes) {
      return (
        <FormattedMessage defaultMessage="Imported from Voquill — action needed" />
      );
    }
    return <FormattedMessage defaultMessage="Imported from Voquill" />;
  })();

  const handleDismiss = () => {
    void dismissVoquillMigration();
  };

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
    <Paper
      variant="outlined"
      role="region"
      aria-label={intl.formatMessage({
        defaultMessage: "Voquill migration status",
      })}
      data-testid="voquill-migration-banner"
      sx={(theme) => ({
        p: 2,
        borderRadius: 2,
        bgcolor: "level1",
        borderColor: isFailure
          ? `rgb(${theme.vars?.palette?.error.mainChannel} / 0.45)`
          : isAttention
            ? `rgb(${theme.vars?.palette?.warning.mainChannel} / 0.45)`
            : "divider",
      })}
    >
      <Stack spacing={1.25}>
        <Stack
          direction="row"
          sx={{
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 1.5,
          }}
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{ alignItems: "flex-start", minWidth: 0 }}
          >
            <Box
              sx={{
                color: accentColor,
                display: "inline-flex",
                mt: "2px",
                flexShrink: 0,
              }}
            >
              {isFailure || isAttention ? (
                <AlertTriangle size={18} strokeWidth={1.9} />
              ) : isSkipped ? (
                <Info size={18} strokeWidth={1.9} />
              ) : (
                <CheckCircle2 size={18} strokeWidth={1.9} />
              )}
            </Box>
            <Stack spacing={0.5} sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {title}
              </Typography>

              {isFailure || isSkipped ? (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {primaryIssue ?? (
                    <FormattedMessage defaultMessage="Your original Voquill files were left untouched." />
                  )}
                </Typography>
              ) : (
                <>
                  {countsSummary && (
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {countsSummary}
                    </Typography>
                  )}
                  {needsKeyAttention && (
                    <Typography
                      variant="body2"
                      sx={{ color: "text.primary", fontWeight: 500 }}
                    >
                      <FormattedMessage
                        defaultMessage="{count, plural, one {# saved API key could not be unlocked from Voquill's older encryption format and needs to be re-entered.} other {# saved API keys could not be unlocked from Voquill's older encryption format and need to be re-entered.}}"
                        values={{
                          count: report.counts.providersNeedingAttention,
                        }}
                      />
                    </Typography>
                  )}
                  {hasRemovedCloudModes && (
                    <Typography
                      variant="body2"
                      sx={{ color: "text.secondary" }}
                    >
                      <FormattedMessage defaultMessage="Previous Voquill Cloud settings were reset to local or off because hosted cloud mode is not included in mausVoice." />
                    </Typography>
                  )}
                  {isPartial && primaryIssue && (
                    <Typography
                      variant="body2"
                      sx={{ color: "text.secondary" }}
                    >
                      {primaryIssue}
                    </Typography>
                  )}
                </>
              )}

              {report.legacySourcePreserved && (
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  <FormattedMessage defaultMessage="Your original Voquill files were left untouched." />
                </Typography>
              )}
            </Stack>
          </Stack>

          <IconButton
            size="small"
            onClick={handleDismiss}
            disabled={dismissing || retrying}
            aria-label={intl.formatMessage({
              defaultMessage: "Dismiss Voquill migration notice",
            })}
            sx={{ mt: -0.5, mr: -0.5, flexShrink: 0 }}
          >
            <X size={16} strokeWidth={1.9} />
          </IconButton>
        </Stack>

        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{
            flexWrap: "wrap",
            alignItems: "center",
            pl: { xs: 0, sm: 3.75 },
          }}
        >
          {(needsKeyAttention || hasRemovedCloudModes) && (
            <Button
              size="small"
              variant="contained"
              endIcon={<ArrowRight size={14} strokeWidth={1.9} />}
              onClick={() => navigate(settingsPagePath("ai-models"))}
            >
              <FormattedMessage defaultMessage="Review API keys" />
            </Button>
          )}
          {report.canRetry && (
            <Button
              size="small"
              variant={
                needsKeyAttention || hasRemovedCloudModes
                  ? "outlined"
                  : "contained"
              }
              onClick={() => void handleRetry()}
              disabled={retrying || dismissing}
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
          )}
          <Button
            size="small"
            variant="text"
            onClick={() =>
              navigate(
                `${settingsPagePath("privacy-data")}#${settingAnchorId("voquill_migration")}`,
              )
            }
          >
            <FormattedMessage defaultMessage="View details" />
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
};

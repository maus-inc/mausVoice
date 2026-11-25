import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import {
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { dismissVoquillMigration } from "../../actions/voquill-migration.actions";
import { useAppStore } from "../../store";
import { settingAnchorId, settingsPagePath } from "../settings/settings-routes";
import {
  VoquillMigrationRetryButton,
  VoquillMigrationReviewKeysButton,
  formatVoquillIssueSummary,
  formatVoquillMigrationCountsSummary,
  useVoquillMigrationRetry,
} from "./voquill-migration-copy";

type BannerTone = "error" | "warning" | "info" | "success";

const resolveBannerTone = (
  report: VoquillMigrationReport,
  needsFollowUp: boolean,
): BannerTone => {
  if (report.status === "failed") return "error";
  if (report.status === "partial" || needsFollowUp) return "warning";
  if (report.status === "skipped_existing_profile") return "info";
  return "success";
};

const BannerTitle = ({
  report,
  needsFollowUp,
}: {
  report: VoquillMigrationReport;
  needsFollowUp: boolean;
}) => {
  if (report.status === "failed") {
    return (
      <FormattedMessage defaultMessage="Could not import your Voquill data" />
    );
  }
  if (report.status === "partial") {
    return (
      <FormattedMessage defaultMessage="Imported from Voquill — some files were skipped" />
    );
  }
  if (report.status === "skipped_existing_profile") {
    return (
      <FormattedMessage defaultMessage="Existing mausVoice profile kept" />
    );
  }
  if (needsFollowUp) {
    return (
      <FormattedMessage defaultMessage="Imported from Voquill — action needed" />
    );
  }
  return <FormattedMessage defaultMessage="Imported from Voquill" />;
};

const BannerToneIcon = ({ tone }: { tone: BannerTone }) => {
  if (tone === "error" || tone === "warning") {
    return <AlertTriangle size={18} strokeWidth={1.9} />;
  }
  if (tone === "info") {
    return <Info size={18} strokeWidth={1.9} />;
  }
  return <CheckCircle2 size={18} strokeWidth={1.9} />;
};

const BannerBody = ({
  report,
  countsSummary,
  primaryIssue,
}: {
  report: VoquillMigrationReport;
  countsSummary: string | null;
  primaryIssue: string | null;
}) => {
  const isFailureOrSkipped =
    report.status === "failed" || report.status === "skipped_existing_profile";
  if (isFailureOrSkipped) {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {primaryIssue ?? (
          <FormattedMessage defaultMessage="Your original Voquill files were left untouched." />
        )}
      </Typography>
    );
  }

  return (
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
      {report.counts.providersNeedingAttention > 0 && (
        <Typography
          variant="body2"
          sx={{ color: "text.primary", fontWeight: 500 }}
        >
          <FormattedMessage
            defaultMessage="{count, plural, one {# saved API key could not be unlocked from Voquill's older encryption format and needs to be re-entered.} other {# saved API keys could not be unlocked from Voquill's older encryption format and need to be re-entered.}}"
            values={{ count: report.counts.providersNeedingAttention }}
          />
        </Typography>
      )}
      {report.removedModesReset.length > 0 && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          <FormattedMessage defaultMessage="Previous Voquill Cloud settings were reset to local or off because hosted cloud mode is not included in mausVoice." />
        </Typography>
      )}
      {report.status === "partial" && primaryIssue && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {primaryIssue}
        </Typography>
      )}
    </>
  );
};

const isBannerVisible = (
  report: VoquillMigrationReport | null,
): report is VoquillMigrationReport =>
  Boolean(
    report &&
    report.legacyDetected &&
    report.status !== "not_needed" &&
    report.dismissedAt === null,
  );

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
  const handleRetry = useVoquillMigrationRetry();

  if (!isBannerVisible(report)) {
    return null;
  }

  const needsFollowUp =
    report.counts.providersNeedingAttention > 0 ||
    report.removedModesReset.length > 0;
  const tone = resolveBannerTone(report, needsFollowUp);
  const countsSummary = formatVoquillMigrationCountsSummary(intl, report);
  const primaryIssue = report.issues[0]
    ? formatVoquillIssueSummary(intl, report.issues[0])
    : null;

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
        borderColor:
          tone === "error"
            ? `rgb(${theme.vars?.palette?.error.mainChannel} / 0.45)`
            : tone === "warning"
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
                color: `${tone}.main`,
                display: "inline-flex",
                mt: "2px",
                flexShrink: 0,
              }}
            >
              <BannerToneIcon tone={tone} />
            </Box>
            <Stack spacing={0.5} sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                <BannerTitle report={report} needsFollowUp={needsFollowUp} />
              </Typography>
              <BannerBody
                report={report}
                countsSummary={countsSummary}
                primaryIssue={primaryIssue}
              />
              {report.legacySourcePreserved && (
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  <FormattedMessage defaultMessage="Your original Voquill files were left untouched." />
                </Typography>
              )}
            </Stack>
          </Stack>

          <IconButton
            size="small"
            onClick={() => void dismissVoquillMigration()}
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
          {needsFollowUp && (
            <VoquillMigrationReviewKeysButton variant="contained" />
          )}
          {report.canRetry && (
            <VoquillMigrationRetryButton
              variant={needsFollowUp ? "outlined" : "contained"}
              isPartial={report.status === "partial"}
              retrying={retrying}
              disabled={dismissing}
              onRetry={() => void handleRetry()}
            />
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

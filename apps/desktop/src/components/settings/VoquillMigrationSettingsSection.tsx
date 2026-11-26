import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useAppStore } from "../../store";
import { SettingRow } from "./SettingRow";
import {
  VoquillMigrationRetryButton,
  VoquillMigrationReviewKeysButton,
  formatVoquillIssueSummary,
  formatVoquillMigrationCountsSummary,
  formatVoquillPhaseLabel,
  hasIncompleteAssetMigration,
  useVoquillMigrationRetry,
} from "../migration/voquill-migration-copy";

type StatusBadgeConfig = {
  color: "error" | "warning" | "default" | "success";
  label: ReactNode;
};

const getMigrationStatusBadge = (
  report: VoquillMigrationReport,
  needsFollowUp: boolean,
): StatusBadgeConfig => {
  if (report.status === "failed") {
    return {
      color: "error",
      label: <FormattedMessage defaultMessage="Failed" />,
    };
  }
  if (report.status === "partial") {
    return {
      color: "warning",
      label: <FormattedMessage defaultMessage="Partial" />,
    };
  }
  if (report.status === "skipped_existing_profile") {
    return {
      color: "default",
      label: <FormattedMessage defaultMessage="Kept existing profile" />,
    };
  }
  if (needsFollowUp) {
    return {
      color: "warning",
      label: <FormattedMessage defaultMessage="Action needed" />,
    };
  }
  return {
    color: "success",
    label: <FormattedMessage defaultMessage="Completed" />,
  };
};

const MigrationSummaryLine = ({
  report,
  countsSummary,
}: {
  report: VoquillMigrationReport;
  countsSummary: string | null;
}) => {
  if (report.status === "skipped_existing_profile") {
    return (
      <FormattedMessage defaultMessage="An older Voquill profile was found on this computer, but your existing mausVoice profile was kept untouched." />
    );
  }
  if (
    report.status === "failed" ||
    (report.status === "partial" && report.databasePhase !== "migrated")
  ) {
    return (
      <FormattedMessage defaultMessage="mausVoice found a Voquill profile but could not finish importing it. Your original Voquill files were not modified." />
    );
  }
  if (countsSummary) {
    return (
      <Box component="span" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {countsSummary}
      </Box>
    );
  }
  return (
    <FormattedMessage defaultMessage="Your Voquill profile was imported into mausVoice." />
  );
};

const MigrationPhaseChips = ({
  report,
}: {
  report: VoquillMigrationReport;
}) => {
  const intl = useIntl();
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      <Chip
        size="small"
        variant="outlined"
        label={intl.formatMessage(
          { defaultMessage: "Database: {status}" },
          { status: formatVoquillPhaseLabel(intl, report.databasePhase) },
        )}
      />
      {report.modelsPhase !== "not_found" && (
        <Chip
          size="small"
          variant="outlined"
          label={intl.formatMessage(
            { defaultMessage: "Models: {status}" },
            { status: formatVoquillPhaseLabel(intl, report.modelsPhase) },
          )}
        />
      )}
      {report.audioPhase !== "not_found" && (
        <Chip
          size="small"
          variant="outlined"
          label={intl.formatMessage(
            { defaultMessage: "Audio: {status}" },
            { status: formatVoquillPhaseLabel(intl, report.audioPhase) },
          )}
        />
      )}
      {report.storagePhase !== "not_found" && (
        <Chip
          size="small"
          variant="outlined"
          label={intl.formatMessage(
            { defaultMessage: "Assets: {status}" },
            { status: formatVoquillPhaseLabel(intl, report.storagePhase) },
          )}
        />
      )}
    </Stack>
  );
};

/**
 * Persistent, always-discoverable Voquill migration report in Settings ->
 * Privacy & Data. Remains accessible after the one-time Home banner is
 * dismissed, and offers truthful phase status, API key review links, and safe
 * retry controls.
 */
export const VoquillMigrationSettingsSection = () => {
  const intl = useIntl();
  const report = useAppStore((state) => state.voquillMigration.report);
  const retrying = useAppStore((state) => state.voquillMigration.retrying);
  const handleRetry = useVoquillMigrationRetry();

  if (!report?.legacyDetected || report.status === "not_needed") {
    return null;
  }

  const needsKeyAttention = report.counts.providersNeedingAttention > 0;
  const hasRemovedCloudModes = report.removedModesReset.length > 0;
  const needsFollowUp = needsKeyAttention || hasRemovedCloudModes;
  const statusBadge = getMigrationStatusBadge(report, needsFollowUp);
  const countsSummary = formatVoquillMigrationCountsSummary(intl, report);

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
            <MigrationSummaryLine
              report={report}
              countsSummary={countsSummary}
            />
          </Typography>

          <MigrationPhaseChips report={report} />

          {needsKeyAttention && (
            <Alert severity="warning" sx={{ py: 0.5, boxShadow: "none" }}>
              <FormattedMessage
                defaultMessage="{count, plural, one {# saved API provider needs attention before it can be used. Review it in AI Models settings.} other {# saved API providers need attention before they can be used. Review them in AI Models settings.}}"
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

          {(needsFollowUp || report.canRetry) && (
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap", pt: 0.25 }}
            >
              {needsFollowUp && (
                <VoquillMigrationReviewKeysButton variant="outlined" />
              )}
              {report.canRetry && (
                <VoquillMigrationRetryButton
                  variant="outlined"
                  retryMissingFiles={hasIncompleteAssetMigration(report)}
                  retrying={retrying}
                  onRetry={() => void handleRetry()}
                />
              )}
            </Stack>
          )}
        </Stack>
      }
    />
  );
};

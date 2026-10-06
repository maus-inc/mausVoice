import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import type { ToolPermission, ToolRisk } from "@maus-inc/types";
import { AlertTriangle, Check, CheckCheck, X } from "lucide-react";
import { FormattedMessage } from "react-intl";
import type { ReactNode } from "react";
import { overlayOnDark } from "../../styles/palette";
import { useAppStore } from "../../store";
import {
  permissionPromptPolicy,
  readPermissionRisk,
} from "../../utils/tool-permission.utils";
import { ToolParamsTooltip } from "./ToolParamsTooltip";

type ToolPermissionPromptProps = {
  permission: ToolPermission;
  variant?: "default" | "overlay";
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
};

type PermissionActionsProps = Pick<
  ToolPermissionPromptProps,
  "onAllow" | "onDeny" | "onAlwaysAllow"
> & { overlay: boolean; risk: ToolRisk | null };

/**
 * The label on the button that runs the action.
 *
 * A `high` action is not something the user waved through, so the button says
 * what it is committing to rather than offering a bare "Allow" next to "Deny".
 */
const AllowLabel = ({ risk }: { risk: ToolRisk | null }) =>
  risk === "high" || risk === "critical" ? (
    <FormattedMessage defaultMessage="Confirm and run" />
  ) : (
    <FormattedMessage defaultMessage="Allow" />
  );

const PermissionActions = ({
  overlay,
  risk,
  onAllow,
  onDeny,
  onAlwaysAllow,
}: PermissionActionsProps) => {
  const iconSize = overlay ? 14 : 16;
  const policy = permissionPromptPolicy({ risk: risk ?? undefined });
  // A `critical` action is never offered a standing grant. "Always allow" is
  // the one button here that survives the conversation and the restart, and
  // there is no tier of consequence that a permanent exemption should outlive.
  const offerAlwaysAllow = policy === null || !policy.warnBeforeRunning;
  const textButtonSx = overlay
    ? { color: overlayOnDark.muted, minWidth: 0 }
    : undefined;
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        justifyContent: overlay ? "flex-end" : "flex-start",
        mt: overlay ? 0.75 : 0,
      }}
    >
      <Button
        size="small"
        variant="text"
        onClick={onDeny}
        startIcon={<X size={iconSize} strokeWidth={1.9} />}
        sx={textButtonSx}
      >
        <FormattedMessage defaultMessage="Deny" />
      </Button>
      <Button
        size="small"
        variant="contained"
        color={risk === "critical" ? "error" : "primary"}
        onClick={onAllow}
        startIcon={<Check size={iconSize} strokeWidth={1.9} />}
      >
        <AllowLabel risk={risk} />
      </Button>
      {offerAlwaysAllow && (
        <Button
          size="small"
          variant="text"
          onClick={onAlwaysAllow}
          startIcon={<CheckCheck size={iconSize} strokeWidth={1.9} />}
          sx={textButtonSx}
        >
          <FormattedMessage defaultMessage="Always allow" />
        </Button>
      )}
    </Stack>
  );
};

const RISK_LABEL: Record<ToolRisk, ReactNode> = {
  low: <FormattedMessage defaultMessage="Reversible" />,
  medium: (
    <FormattedMessage defaultMessage="Changes something on your screen" />
  ),
  high: <FormattedMessage defaultMessage="Hard to undo" />,
  critical: <FormattedMessage defaultMessage="Can destroy what you have" />,
};

const PermissionDetails = ({
  permission,
  overlay,
}: {
  permission: ToolPermission;
  overlay: boolean;
}) => {
  const toolInfo = useAppStore((s) => s.toolInfoById[permission.toolId]);
  // Persisted/provider parameters are unknown values, not safe React children.
  const reason =
    typeof permission.params.reason === "string"
      ? permission.params.reason
      : null;
  const allowed = permission.status === "allowed";
  const risk = readPermissionRisk(permission.params);
  const policy = permissionPromptPolicy(permission.params);
  const appearance = overlay
    ? {
        heading: overlayOnDark.text,
        secondary: overlayOnDark.muted,
        iconSize: 14,
      }
    : { heading: undefined, secondary: "text.secondary", iconSize: 16 };
  return (
    <Stack spacing={0.25}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            color: appearance.heading,
          }}
        >
          {toolInfo?.description ?? permission.toolId}
        </Typography>
        {risk && (
          <Chip
            size="small"
            variant="outlined"
            sx={{ color: appearance.secondary }}
            label={RISK_LABEL[risk]}
          />
        )}
        <ToolParamsTooltip
          params={permission.params}
          iconColor={appearance.secondary}
          iconSize={appearance.iconSize}
        />
        {!overlay && permission.status !== "pending" && (
          <Chip
            size="small"
            color={allowed ? "success" : "error"}
            sx={{ ml: "auto" }}
            label={
              allowed ? (
                <FormattedMessage defaultMessage="Allowed" />
              ) : (
                <FormattedMessage defaultMessage="Denied" />
              )
            }
          />
        )}
      </Stack>
      {reason && (
        <Typography variant="caption" sx={{ color: appearance.secondary }}>
          {reason}
        </Typography>
      )}
      {policy?.warnBeforeRunning && (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "flex-start" }}>
          <AlertTriangle
            size={appearance.iconSize}
            strokeWidth={1.9}
            style={{ marginTop: 2, flexShrink: 0 }}
            color={appearance.secondary}
          />
          <Typography variant="caption" sx={{ color: appearance.secondary }}>
            <FormattedMessage defaultMessage="This one cannot be taken back. Check the screen before you confirm." />
          </Typography>
        </Stack>
      )}
    </Stack>
  );
};

export const ToolPermissionPrompt = ({
  permission,
  variant = "default",
  onAllow,
  onDeny,
  onAlwaysAllow,
}: ToolPermissionPromptProps) => {
  const overlay = variant === "overlay";
  const risk = readPermissionRisk(permission.params);
  const details = (
    <PermissionDetails permission={permission} overlay={overlay} />
  );
  const actions =
    permission.status === "pending" ? (
      <PermissionActions
        overlay={overlay}
        risk={risk}
        onAllow={onAllow}
        onDeny={onDeny}
        onAlwaysAllow={onAlwaysAllow}
      />
    ) : null;

  if (overlay) {
    return (
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderRadius: 1,
          border: `1px solid ${overlayOnDark.hairline}`,
          backgroundColor: overlayOnDark.wash,
        }}
      >
        {details}
        {actions}
      </Box>
    );
  }
  return (
    <Stack direction="row" sx={{ justifyContent: "flex-start" }}>
      <Box
        sx={{
          maxWidth: "75%",
          px: 2,
          py: 1.5,
          borderRadius: 2.5,
          border: 1,
          borderColor: "divider",
          bgcolor: "level1",
        }}
      >
        <Stack spacing={1}>
          {details}
          {actions}
        </Stack>
      </Box>
    </Stack>
  );
};

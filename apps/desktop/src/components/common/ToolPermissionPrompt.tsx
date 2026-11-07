import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import type { ToolPermission } from "@maus-inc/types";
import { Check, CheckCheck, X } from "lucide-react";
import { FormattedMessage } from "react-intl";
import { overlayOnDark } from "../../styles/palette";
import { useAppStore } from "../../store";
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
> & { overlay: boolean };

const PermissionActions = ({
  overlay,
  onAllow,
  onDeny,
  onAlwaysAllow,
}: PermissionActionsProps) => {
  const iconSize = overlay ? 14 : 16;
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
        onClick={onAllow}
        startIcon={<Check size={iconSize} strokeWidth={1.9} />}
      >
        <FormattedMessage defaultMessage="Allow" />
      </Button>
      <Button
        size="small"
        variant="text"
        onClick={onAlwaysAllow}
        startIcon={<CheckCheck size={iconSize} strokeWidth={1.9} />}
        sx={textButtonSx}
      >
        <FormattedMessage defaultMessage="Always allow" />
      </Button>
    </Stack>
  );
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
  const details = (
    <PermissionDetails permission={permission} overlay={overlay} />
  );
  const actions =
    permission.status === "pending" ? (
      <PermissionActions
        overlay={overlay}
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

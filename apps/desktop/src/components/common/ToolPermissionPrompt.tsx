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

export const ToolPermissionPrompt = ({
  permission,
  variant = "default",
  onAllow,
  onDeny,
  onAlwaysAllow,
}: ToolPermissionPromptProps) => {
  const toolInfo = useAppStore((s) => s.toolInfoById[permission.toolId]);
  const isPending = permission.status === "pending";
  const reason = permission.params.reason as string | undefined;

  if (variant === "overlay") {
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
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Typography variant="body2" sx={{ fontWeight: 600, color: overlayOnDark.text }}>
            {toolInfo?.description ?? permission.toolId}
          </Typography>
          <ToolParamsTooltip
            params={permission.params}
            iconColor={overlayOnDark.muted}
            iconSize={14}
          />
        </Stack>
        {reason && (
          <Typography variant="caption" sx={{ color: overlayOnDark.muted, mt: 0.25 }}>
            {reason}
          </Typography>
        )}
        {isPending && (
          <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end", mt: 0.75 }}>
            <Button
              size="small"
              variant="text"
              onClick={onDeny}
              startIcon={<X size={14} strokeWidth={1.9} />}
              sx={{ color: overlayOnDark.muted, minWidth: 0 }}
            >
              <FormattedMessage defaultMessage="Deny" />
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={onAllow}
              startIcon={<Check size={14} strokeWidth={1.9} />}
            >
              <FormattedMessage defaultMessage="Allow" />
            </Button>
            <Button
              size="small"
              variant="text"
              onClick={onAlwaysAllow}
              startIcon={<CheckCheck size={14} strokeWidth={1.9} />}
              sx={{ color: overlayOnDark.muted, minWidth: 0 }}
            >
              <FormattedMessage defaultMessage="Always allow" />
            </Button>
          </Stack>
        )}
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
          borderRadius: 1,
          border: 1,
          borderColor: "divider",
          bgcolor: "level1",
        }}
      >
        <Stack spacing={1}>
          <Stack spacing={0.25}>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {toolInfo?.description ?? permission.toolId}
              </Typography>
              <ToolParamsTooltip params={permission.params} />
              {!isPending && (
                <Chip
                  size="small"
                  label={permission.status}
                  color={permission.status === "allowed" ? "success" : "error"}
                  sx={{ ml: "auto" }}
                />
              )}
            </Stack>
            {reason && (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {reason}
              </Typography>
            )}
          </Stack>

          {isPending && (
            <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-start" }}>
              <Button size="small" variant="text" onClick={onDeny} startIcon={<X size={16} strokeWidth={1.9} />}>
                <FormattedMessage defaultMessage="Deny" />
              </Button>
              <Button size="small" variant="contained" onClick={onAllow} startIcon={<Check size={16} strokeWidth={1.9} />}>
                <FormattedMessage defaultMessage="Allow" />
              </Button>
              <Button
                size="small"
                variant="text"
                onClick={onAlwaysAllow}
                startIcon={<CheckCheck size={16} strokeWidth={1.9} />}
              >
                <FormattedMessage defaultMessage="Always allow" />
              </Button>
            </Stack>
          )}
        </Stack>
      </Box>
    </Stack>
  );
};

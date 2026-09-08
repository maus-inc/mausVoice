/**
 * ToolPermissionPrompt — recreated (both variants) + card wiring.
 *
 * Why recreated: reads toolInfoById from the zustand store; the card wrapper
 * dispatches resolveToolPermission/setToolAlwaysAllow actions. Styles below
 * are copied verbatim from components/common/ToolPermissionPrompt.tsx; the
 * real ToolParamsTooltip is reused inside.
 */
import { CheckRounded, CloseRounded, DoneAllRounded } from "@mui/icons-material";
import { Box, Chip, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { ToolParamsTooltip } from "@desktop/components/common/ToolParamsTooltip";

export type PermissionFixture = {
  toolId: string;
  toolDescription: string;
  params: Record<string, unknown>;
  reason?: string;
  status: "pending" | "allowed" | "denied";
};

const OverlayButton = ({
  children,
  color,
  filled,
  bordered,
  onMouseDown,
}: {
  children: React.ReactNode;
  color?: string;
  filled?: boolean;
  bordered?: boolean;
  onMouseDown: () => void;
}) => {
  const theme = useTheme();
  const whiteMid = alpha(theme.palette.common.white, 0.5);
  return (
    <Box
      component="button"
      onMouseDown={(e: React.MouseEvent) => {
        e.stopPropagation();
        onMouseDown();
      }}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        py: 0.25,
        fontSize: 12,
        fontWeight: 500,
        color: filled ? theme.palette.common.black : (color ?? whiteMid),
        backgroundColor: filled ? theme.palette.common.white : "transparent",
        border: bordered
          ? `1px solid ${alpha(theme.palette.common.white, 0.2)}`
          : filled
            ? `1px solid ${theme.palette.common.white}`
            : "none",
        borderRadius: 1,
        cursor: "pointer",
        "&:hover": {
          backgroundColor: filled
            ? alpha(theme.palette.common.white, 0.85)
            : alpha(theme.palette.common.white, 0.08),
        },
      }}
    >
      {children}
    </Box>
  );
};

export const ToolPermissionPromptPreview = ({
  permission,
  variant = "default",
  onAllow = () => {},
  onDeny = () => {},
  onAlwaysAllow = () => {},
}: {
  permission: PermissionFixture;
  variant?: "default" | "overlay";
  onAllow?: () => void;
  onDeny?: () => void;
  onAlwaysAllow?: () => void;
}) => {
  const theme = useTheme();
  const isPending = permission.status === "pending";

  if (variant === "overlay") {
    const whiteHigh = alpha(theme.palette.common.white, 0.92);
    const whiteMid = alpha(theme.palette.common.white, 0.5);
    return (
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderRadius: 1,
          border: `1px solid ${alpha(theme.palette.common.white, 0.2)}`,
          backgroundColor: alpha(theme.palette.common.white, 0.06),
        }}
      >
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600, color: whiteHigh }}>
            {permission.toolDescription}
          </Typography>
          <ToolParamsTooltip params={permission.params} iconColor={whiteMid} iconSize={14} />
        </Stack>
        {permission.reason && (
          <Typography sx={{ fontSize: 12, color: whiteMid, mt: 0.25 }}>
            {permission.reason}
          </Typography>
        )}
        {isPending && (
          <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", mt: 0.75 }}>
            <OverlayButton color={whiteMid} bordered onMouseDown={onDeny}>
              <CloseRounded sx={{ fontSize: 14 }} />
              Deny
            </OverlayButton>
            <OverlayButton filled onMouseDown={onAllow}>
              <CheckRounded sx={{ fontSize: 14 }} />
              Allow
            </OverlayButton>
            <OverlayButton color={whiteMid} onMouseDown={onAlwaysAllow}>
              <DoneAllRounded sx={{ fontSize: 14 }} />
              Always allow
            </OverlayButton>
          </Box>
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
          borderColor: "primary.main",
          bgcolor: "background.paper",
        }}
      >
        <Stack spacing={1}>
          <Stack spacing={0.25}>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {permission.toolDescription}
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
            {permission.reason && (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {permission.reason}
              </Typography>
            )}
          </Stack>
          {isPending && (
            <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-start" }}>
              <Chip size="small" variant="outlined" label="Deny" icon={<CloseRounded />} onClick={onDeny} />
              <Chip size="small" color="primary" label="Allow" icon={<CheckRounded />} onClick={onAllow} />
              <Chip
                size="small"
                variant="outlined"
                label="Always allow"
                icon={<DoneAllRounded />}
                sx={{ border: "none" }}
                onClick={onAlwaysAllow}
              />
            </Stack>
          )}
        </Stack>
      </Box>
    </Stack>
  );
};

export const PERMISSION_FIXTURES: PermissionFixture[] = [
  {
    toolId: "read_file",
    toolDescription: "Read package.json",
    params: { path: "package.json", reason: "Need the project manifest" },
    reason: "Need the project manifest to continue.",
    status: "pending",
  },
  {
    toolId: "run_command",
    toolDescription: "Run pnpm build",
    params: { command: "pnpm build" },
    status: "allowed",
  },
  {
    toolId: "delete_file",
    toolDescription: "Delete scratch.txt",
    params: { path: "scratch.txt" },
    status: "denied",
  },
];

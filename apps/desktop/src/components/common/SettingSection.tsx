import { Box, Stack, SxProps, Typography } from "@mui/material";
import { ReactNode } from "react";

type SettingSectionProps = {
  title: ReactNode;
  /** Plain-text or inline description rendered inside a Typography. */
  description?: ReactNode;
  /**
   * Rich description rendered without an enclosing Typography, so callers can
   * supply their own layout (stacks, custom typography, status roles).
   */
  descriptionSlot?: ReactNode;
  action?: ReactNode;
  sx?: SxProps;
};

export const SettingSection = ({
  title,
  description,
  descriptionSlot,
  action,
  sx,
}: SettingSectionProps) => {
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={[
        {
          alignItems: "center",
          justifyContent: "space-between",
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <Stack
        spacing={0.5}
        sx={{
          flex: 1,
        }}
      >
        <Typography
          variant="body1"
          sx={{
            fontWeight: 600,
          }}
        >
          {title}
        </Typography>
        {descriptionSlot ?? (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {description}
          </Typography>
        )}
      </Stack>
      {action && <Box>{action}</Box>}
    </Stack>
  );
};

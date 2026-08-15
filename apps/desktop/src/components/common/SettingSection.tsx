import { Box, Stack, SxProps, Typography } from "@mui/material";
import { ReactNode } from "react";

type SettingSectionProps = {
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  sx?: SxProps;
};

export const SettingSection = ({
  title,
  description,
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
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {description}
        </Typography>
      </Stack>
      {action && <Box>{action}</Box>}
    </Stack>
  );
};

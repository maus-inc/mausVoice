import type { ReactNode } from "react";
import { Card, CardContent, Stack, Typography, useTheme } from "@mui/material";

type HomeMetricCardProps = {
  label: ReactNode;
  value: string;
  icon?: ReactNode;
  detail?: ReactNode;
};

export const HomeMetricCard = ({
  label,
  value,
  icon,
  detail,
}: HomeMetricCardProps) => {
  const theme = useTheme();

  return (
    <Card sx={{ height: "100%" }}>
      <CardContent
        sx={{
          py: theme.spacing(2),
          px: theme.spacing(2.5),
          "&:last-child": { pb: theme.spacing(2) },
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", mb: theme.spacing(0.5) }}
        >
          {icon}
          <Typography
            variant="h5"
            sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
          >
            {value}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {label}
        </Typography>
        {detail ? (
          <Typography
            variant="caption"
            sx={{
              display: "block",
              color: "text.secondary",
              mt: theme.spacing(0.75),
            }}
          >
            {detail}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
};

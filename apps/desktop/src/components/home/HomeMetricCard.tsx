import type { ReactNode } from "react";
import { Card, CardContent, Stack, Typography } from "@mui/material";

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
}: HomeMetricCardProps) => (
  <Card sx={{ height: "100%" }}>
    <CardContent sx={{ py: 2, px: 2.5, "&:last-child": { pb: 2 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
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
          sx={{ display: "block", color: "text.secondary", mt: 0.75 }}
        >
          {detail}
        </Typography>
      ) : null}
    </CardContent>
  </Card>
);

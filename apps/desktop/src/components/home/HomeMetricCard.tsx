import type { ReactNode } from "react";
import { Card, CardContent, Stack, Typography } from "@mui/material";

type HomeMetricCardProps = {
  label?: ReactNode;
  value: string;
  icon?: ReactNode;
  detail?: ReactNode;
  align?: "left" | "right";
};

export const HomeMetricCard = ({
  label,
  value,
  icon,
  detail,
  align = "left",
}: HomeMetricCardProps) => {
  const rightAligned = align === "right";

  return (
    <Card sx={{ height: "100%" }}>
      <CardContent
        sx={{
          py: 1.1875,
          px: 2,
          "&:last-child": { pb: 1.1875 },
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            justifyContent: rightAligned ? "flex-end" : "flex-start",
            mb: label ? 0.5 : 0,
          }}
        >
          {icon}
          <Typography
            variant="h5"
            sx={{
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {value}
          </Typography>
        </Stack>
        {label ? (
          <Typography
            variant="body2"
            align={align}
            sx={{ color: "text.secondary", whiteSpace: "nowrap" }}
          >
            {label}
          </Typography>
        ) : null}
        {detail ? (
          <Typography
            variant="caption"
            align={align}
            sx={{
              display: "block",
              color: "text.secondary",
              mt: label ? 0.75 : 0.5,
              whiteSpace: "nowrap",
              fontSize: "0.72rem",
            }}
          >
            {detail}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
};

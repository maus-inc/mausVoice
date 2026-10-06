import { Box, Card, CardContent, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

type HomeMetricCardProps = {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
};

export const HomeMetricCard = ({
  label,
  value,
  detail,
  icon,
}: HomeMetricCardProps) => (
  <Card sx={{ height: "100%", minWidth: 0 }}>
    <CardContent
      sx={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 0.75,
        minWidth: 0,
        p: { xs: 1.75, md: 2.25 },
        "&:last-child": { pb: { xs: 1.75, md: 2.25 } },
      }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontWeight: 550, overflowWrap: "anywhere" }}
      >
        {label}
      </Typography>
      <Stack
        direction="row"
        spacing={1}
        sx={{ minWidth: 0, alignItems: "center" }}
      >
        {icon && (
          <Box sx={{ display: "flex", flexShrink: 0, alignItems: "center" }}>
            {icon}
          </Box>
        )}
        <Typography
          variant="h5"
          component="div"
          sx={{
            minWidth: 0,
            fontWeight: 700,
            lineHeight: 1.15,
            fontVariantNumeric: "tabular-nums",
            overflowWrap: "anywhere",
          }}
        >
          {value}
        </Typography>
      </Stack>
      {detail && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ lineHeight: 1.45, overflowWrap: "anywhere" }}
        >
          {detail}
        </Typography>
      )}
    </CardContent>
  </Card>
);

import { Box, Container, Stack, Typography } from "@mui/material";
import { type ReactNode } from "react";

export type CenterMessageProps = {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly action?: ReactNode;
};

export function CenterMessage({ title, subtitle, action }: CenterMessageProps) {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        px: 2,
        py: 8,
      }}
    >
      <Container maxWidth="xs">
        <Stack
          spacing={2}
          sx={{
            alignItems: "center",
            pb: 8,
          }}
        >
          <Typography
            variant="h5"
            align="center"
            sx={{
              fontWeight: 600,
            }}
          >
            {title}
          </Typography>
          {subtitle && (
            <Typography
              variant="body1"
              align="center"
              sx={{
                color: "text.secondary",
              }}
            >
              {subtitle}
            </Typography>
          )}
          {action}
        </Stack>
      </Container>
    </Box>
  );
}

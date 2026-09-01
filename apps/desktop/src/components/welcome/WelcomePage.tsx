import { Box, Button, Stack, Typography, useTheme } from "@mui/material";
import { useEffect } from "react";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { resetOnboarding } from "../../actions/onboarding.actions";
import { clearGotStartedAt } from "../../actions/user.actions";
import { useAppStore } from "../../store";
import { getShouldGoToOnboarding } from "../../utils/user.utils";
import { Logo } from "../common/Logo";
import { VectorField } from "./VectorField";

export default function WelcomePage() {
  const theme = useTheme();
  const nav = useNavigate();
  const shouldGotoOnboarding = useAppStore(getShouldGoToOnboarding);

  const handleGetStarted = () => {
    resetOnboarding();
    nav("/onboarding");
  };

  const handleLogin = () => {
    resetOnboarding();
    nav("/login?mode=login");
  };

  useEffect(() => {
    if (shouldGotoOnboarding) {
      nav("/onboarding");
      clearGotStartedAt();
    }
  }, [shouldGotoOnboarding]);

  return (
    <Box
      sx={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <VectorField />
      <Stack
        sx={{
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          zIndex: 1,
          minHeight: "100%",
          width: "100%",
          px: 3,
          py: 6,
        }}
      >
        <Stack
          spacing={6}
          sx={{
            alignItems: "center",
            textAlign: "center",
            maxWidth: 420,
            position: "relative",
            backgroundColor: theme.vars?.palette.background.default,
            boxShadow: `0 0 120px 120px ${theme.vars?.palette.background.default}`,
            borderRadius: 8,
            p: 4,
          }}
        >
          <Stack
            spacing={2}
            sx={{
              alignItems: "center",
            }}
          >
            <Stack
              direction="row"
              spacing={1}
              sx={{
                alignItems: "center",
              }}
            >
              <Logo width="4rem" height="4rem" />
              <Typography
                variant="h3"
                sx={{
                  fontWeight: 700,
                }}
              >
                mausVoice
              </Typography>
            </Stack>
            <Typography
              variant="body1"
              sx={{
                color: "text.secondary",
              }}
            >
              <FormattedMessage defaultMessage="Voice is your new keyboard." />
            </Typography>
          </Stack>

          <Stack
            spacing={1.5}
            sx={{
              width: "100%",
            }}
          >
            <Button
              variant="contained"
              size="large"
              fullWidth
              onClick={handleGetStarted}
            >
              <FormattedMessage defaultMessage="Get started" />
            </Button>
            <Button variant="text" size="large" fullWidth onClick={handleLogin}>
              <FormattedMessage defaultMessage="I already have an account" />
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </Box>
  );
}

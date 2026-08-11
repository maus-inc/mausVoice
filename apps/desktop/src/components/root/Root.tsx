import { Box, Button, Stack } from "@mui/material";
import { Suspense, useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { FormattedMessage } from "react-intl";
import { Outlet, useLocation } from "react-router-dom";
import { trackPageView } from "../../utils/analytics.utils";
import { getLogger } from "../../utils/log.utils";
import { LoadingApp } from "./LoadingApp";
import { OverlaySyncSideEffects } from "./OverlaySyncSideEffects";
import { PermissionSideEffects } from "./PermissionSideEffects";
import { RootConfetti } from "./RootConfetti";
import { RootDialogs } from "./RootDialogs";
import { RootSideEffects } from "./RootSideEffects";

function ErrorFallback({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Box sx={{ padding: 2 }}>
      <h2>
        <FormattedMessage defaultMessage="Something went wrong:" />
      </h2>
      <pre style={{ whiteSpace: "pre-wrap" }}>{message}</pre>
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button variant="contained" onClick={resetErrorBoundary}>
          <FormattedMessage defaultMessage="Try again" />
        </Button>
        <Button
          variant="outlined"
          onClick={() => {
            window.location.href = "/";
          }}
        >
          <FormattedMessage defaultMessage="Reload app" />
        </Button>
      </Stack>
    </Box>
  );
}

export default function Root() {
  const location = useLocation();

  useEffect(() => {
    trackPageView(location.pathname);
  }, [location.pathname]);

  return (
    <>
      <PermissionSideEffects />
      <RootConfetti />
      <RootSideEffects />
      <OverlaySyncSideEffects />
      <RootDialogs />
      {/* resetKeys auto-retries the crashed subtree once the route changes, so
          a transient commit fault can never strand the user on the fallback;
          the fallback's buttons cover the deterministic-fault case. */}
      <ErrorBoundary
        FallbackComponent={ErrorFallback}
        resetKeys={[location.pathname]}
        onError={(error) => {
          getLogger().error(
            `UI crashed at ${location.pathname}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }}
      >
        <Suspense fallback={<LoadingApp />}>
          <Box sx={{ width: "100%", height: "100%" }}>
            <Outlet />
          </Box>
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

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
import { ContextMenuProvider } from "../common/ContextMenu";

function ErrorFallback({
  resetErrorBoundary,
}: {
  readonly resetErrorBoundary: () => void;
}) {
  return (
    <Box sx={{ padding: 2 }}>
      <h2>
        <FormattedMessage defaultMessage="Something went wrong:" />
      </h2>
      <FormattedMessage defaultMessage="The application encountered an unexpected error." />
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
    <ContextMenuProvider>
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
          // Log only a stable error category — raw error.message can contain
          // unsanitized user data (stack frames, form values, API responses).
          const category =
            error instanceof Error ? error.constructor.name : "UnknownError";
          getLogger().error(`UI crashed at ${location.pathname}: ${category}`);
        }}
      >
        <Suspense fallback={<LoadingApp />}>
          <Box sx={{ width: "100%", height: "100%" }}>
            <Outlet />
          </Box>
        </Suspense>
      </ErrorBoundary>
    </ContextMenuProvider>
  );
}

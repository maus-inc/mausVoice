import { Box } from "@mui/material";
import {
  isReadyForFullApp,
  shouldMountPostElevationSideEffects,
} from "../../actions/elevation.actions";
import Router from "../../router";
import { useAppStore } from "../../store";
import { AppSideEffects } from "./AppSideEffects";
import { DictationSideEffects } from "./DictationSideEffects";
import { ElevationDeclinedDialog } from "./ElevationDeclinedDialog";
import { KeyPressSideEffects } from "./KeyPressSideEffects";
import { MigratorSideEffects } from "./MigratorSideEffects";
import { SessionSideEffects } from "./SessionSideEffects";
import { LoadingApp } from "./LoadingApp";
import { UpdateDialog } from "./UpdateDialog";

export const AppWithLoading = () => {
  const initialized = useAppStore((state) => state.initialized);
  const hotkeyStrategy = useAppStore((state) => state.hotkeyStrategy);
  // Hold the full app (auth, dashboard, dictation) behind the Windows
  // elevation pre-flight. Cleared immediately on non-Windows / once the UAC
  // decision is resolved (including "Launch normally").
  const elevationStartupPending = useAppStore(
    (state) => state.settings.elevationStartupPending,
  );

  const readyForApp = isReadyForFullApp({
    initialized,
    elevationStartupPending,
  });

  return (
    <>
      {/* Elevation gate runs inside AppSideEffects; always mount it. */}
      <AppSideEffects />
      <ElevationDeclinedDialog />
      {shouldMountPostElevationSideEffects(elevationStartupPending) && (
        <>
          {hotkeyStrategy === "bridge" && <KeyPressSideEffects />}
          <UpdateDialog />
          <MigratorSideEffects />
          <DictationSideEffects />
          <SessionSideEffects />
        </>
      )}
      <Box sx={{ height: "100dvh", width: "100vw", overflow: "hidden" }}>
        {readyForApp ? <Router /> : <LoadingApp />}
      </Box>
    </>
  );
};

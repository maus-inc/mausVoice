import { useEffect } from "react";
import { isReadyForFullApp } from "../../actions/elevation.actions";
import { useElevationStartupReady } from "../../hooks/elevation.hooks";
import Router from "../../router";
import { useAppStore } from "../../store";
import { prewarmDashboardKeycap } from "../common/keycap3d.prewarm";
import { AppSideEffects } from "./AppSideEffects";
import { AppViewport } from "./AppViewport";
import { DictationSideEffects } from "./DictationSideEffects";
import { ElevationDeclinedDialog } from "./ElevationDeclinedDialog";
import { EditWatchSideEffects } from "./EditWatchSideEffects";
import { KeyPressSideEffects } from "./KeyPressSideEffects";
import { LocateGestureSideEffects } from "./LocateGestureSideEffects";
import { MigratorSideEffects } from "./MigratorSideEffects";
import { SessionSideEffects } from "./SessionSideEffects";
import { LoadingApp } from "./LoadingApp";
import { UpdateDialog } from "./UpdateDialog";

export const AppWithLoading = () => {
  useEffect(() => {
    const timer = setTimeout(prewarmDashboardKeycap, 0);
    return () => clearTimeout(timer);
  }, []);

  const initialized = useAppStore((state) => state.initialized);
  const hotkeyStrategy = useAppStore((state) => state.hotkeyStrategy);
  // Hold the full app (auth, dashboard, dictation) behind the Windows
  // elevation pre-flight. Cleared immediately on non-Windows / once the UAC
  // decision is resolved (including "Launch normally").
  const elevationReady = useElevationStartupReady();
  const readyForApp = isReadyForFullApp(initialized, elevationReady);

  return (
    <>
      {/* Elevation gate runs inside AppSideEffects; always mount it. */}
      <AppSideEffects />
      <ElevationDeclinedDialog />
      {elevationReady && (
        <>
          {hotkeyStrategy === "bridge" && <KeyPressSideEffects />}
          <LocateGestureSideEffects />
          <UpdateDialog />
          <MigratorSideEffects />
          <DictationSideEffects />
          <EditWatchSideEffects />
          <SessionSideEffects />
        </>
      )}
      <AppViewport>{readyForApp ? <Router /> : <LoadingApp />}</AppViewport>
    </>
  );
};

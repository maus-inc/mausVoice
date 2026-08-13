import { Box } from "@mui/material";
import Router from "../../router";
import { useAppStore } from "../../store";
import { AppSideEffects } from "./AppSideEffects";
import { DictationSideEffects } from "./DictationSideEffects";
import { KeyPressSideEffects } from "./KeyPressSideEffects";
import { MigratorSideEffects } from "./MigratorSideEffects";
import { SessionSideEffects } from "./SessionSideEffects";
import { LoadingApp } from "./LoadingApp";
import { UpdateDialog } from "./UpdateDialog";
import { getHasPaidAccess } from "../../utils/member.utils";

export const AppWithLoading = () => {
  const initialized = useAppStore((state) => state.initialized);
  const hotkeyStrategy = useAppStore((state) => state.hotkeyStrategy);
  const hasPaidAccess = useAppStore(getHasPaidAccess);

  return (
    <>
      {hotkeyStrategy === "bridge" && <KeyPressSideEffects />}
      <AppSideEffects />
      <UpdateDialog />
      <MigratorSideEffects />
      <DictationSideEffects />
      {hasPaidAccess && <SessionSideEffects />}
      <Box sx={{ height: "100dvh", width: "100vw", overflow: "hidden" }}>
        {initialized ? <Router /> : <LoadingApp />}
      </Box>
    </>
  );
};

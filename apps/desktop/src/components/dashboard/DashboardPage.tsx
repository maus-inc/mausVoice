import { Box, Stack, Typography } from "@mui/material";
import { getVersion } from "@tauri-apps/api/app";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Outlet, useLocation } from "react-router-dom";
import { useAsyncData } from "../../hooks/async.hooks";
import { easeOutQuint } from "../../styles/motion";
import { TranscriptionDetailsDialog } from "../transcriptions/TranscriptionDetailsDialog";
import { DashboardMenu } from "./DashboardMenu";
import { FeatureReleaseDialog } from "./FeatureReleaseDialog";
import { PermissionsDialog } from "./PermissionsDialog";

/**
 * Authenticated app shell: sidebar navigation, routed content area, and the
 * global dialogs (feature release, permissions, trial ended, transcription
 * details). Also reports the app version into the layout.
 */
export default function DashboardPage() {
  const data = useAsyncData(getVersion, []);
  const location = useLocation();
  const reduceMotion = useReducedMotion();

  return (
    <>
      <FeatureReleaseDialog />
      <PermissionsDialog />
      <TranscriptionDetailsDialog />
      <Stack
        direction="row"
        sx={{ height: "100%", width: "100%", overflow: "hidden" }}
      >
        <Box
          sx={{
            display: { xs: "none", sm: "flex" },
            flexDirection: "column",
            width: 232,
            minWidth: 232,
            maxWidth: 232,
            overflowY: "auto",
            py: 0.5,
          }}
        >
          <DashboardMenu />
        </Box>
        <Box
          sx={{
            flexGrow: 1,
            minWidth: 0,
            height: "100%",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            p: { xs: 1, sm: 1.5 },
            pt: { xs: 0.5, sm: 1 },
          }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            <Box
              component={motion.div}
              key={
                location.key ??
                `${location.pathname}${location.search}${location.hash}`
              }
              initial={reduceMotion ? false : { opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, x: -6 }}
              transition={{
                duration: reduceMotion ? 0 : 0.24,
                ease: easeOutQuint,
              }}
              sx={{
                flexGrow: 1,
                minHeight: 0,
                overflow: "auto",
              }}
            >
              <Outlet />
            </Box>
          </AnimatePresence>
        </Box>
        <Typography
          variant="caption"
          sx={{
            position: "fixed",
            bottom: 6,
            left: 10,
            fontSize: "0.55rem",
            color: "text.secondary",
            opacity: 0.35,
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          {data.state === "success" ? `v${data.data}` : ""}
        </Typography>
      </Stack>
    </>
  );
}

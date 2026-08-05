import { Box, Stack, Typography } from "@mui/material";
import { getVersion } from "@tauri-apps/api/app";
import { motion, useReducedMotion } from "framer-motion";
import { Outlet, useLocation } from "react-router-dom";
import { useAsyncData } from "../../hooks/async.hooks";
import { easeOutQuint } from "../../styles/motion";
import { TranscriptionDetailsDialog } from "../transcriptions/TranscriptionDetailsDialog";
import { DashboardMenu } from "./DashboardMenu";
import { FeatureReleaseDialog } from "./FeatureReleaseDialog";
import { PermissionsDialog } from "./PermissionsDialog";
import { TrialEndedDialog } from "./TrialEndedDialog";

export default function DashboardPage() {
  const data = useAsyncData(getVersion, []);
  const location = useLocation();
  const reduceMotion = useReducedMotion();

  return (
    <>
      <FeatureReleaseDialog />
      <PermissionsDialog />
      <TranscriptionDetailsDialog />
      <TrialEndedDialog />
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
          <Box
            component={motion.div}
            key={location.pathname}
            initial={
              reduceMotion ? false : { opacity: 0, y: 8, filter: "blur(2px)" }
            }
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.22, ease: easeOutQuint }}
            sx={{
              flexGrow: 1,
              minHeight: 0,
              overflow: "auto",
              borderRadius: 3,
              bgcolor: "level1",
              border: (theme) =>
                theme.palette.mode === "dark"
                  ? "1px solid rgba(255,255,255,0.05)"
                  : "1px solid rgba(15,18,25,0.05)",
              boxShadow: (theme) =>
                theme.palette.mode === "dark"
                  ? "inset 0 1px 0 rgba(255,255,255,0.06), inset 0 2px 0 rgba(255,255,255,0.02), 0 10px 28px rgba(0,0,0,0.28)"
                  : "inset 0 1px 0 rgba(255,255,255,0.95), inset 0 2px 0 rgba(255,255,255,0.4), 0 8px 24px rgba(15,18,25,0.06)",
            }}
          >
            <Outlet />
          </Box>
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

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

/**
 * Renders the dashboard layout with responsive navigation, routed content, dialogs, and the application version caption.
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
            // Flat: the route content owns its own surfaces (cards, rows), so
            // wrapping it in a second bordered panel stacked two tiers of
            // elevation for one plane and boxed the page inside the page.
            sx={{
              flexGrow: 1,
              minHeight: 0,
              overflow: "auto",
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

import { Box, Stack, Typography } from "@mui/material";
import { getVersion } from "@tauri-apps/api/app";
import { Outlet } from "react-router-dom";
import { useAsyncData } from "../../hooks/async.hooks";
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
          {/* A routed Outlet must have a single owner. Keeping an outgoing
              Outlet alive during an exit animation lets it follow the new
              route and run its effects/cleanup alongside the incoming page. */}
          <Box sx={{ flexGrow: 1, minHeight: 0, overflow: "auto" }}>
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

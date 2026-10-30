import { Box, Stack, Typography } from "@mui/material";
import { getVersion } from "@tauri-apps/api/app";
import { motion, useReducedMotion } from "framer-motion";
import { useLayoutEffect, useRef } from "react";
import { Outlet, useLocation, useMatch } from "react-router-dom";
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
 *
 * The content area is deliberately flat. It carries no fill, border, radius or
 * cast of its own, so the routed page reads as the window's canvas rather than
 * as a card sitting on it. A panel treatment here cuts the window into
 * compartments and turns a navigation change into a frame change. Chrome that
 * does need its own material, such as the rail, paints it on the rail.
 */
export default function DashboardPage() {
  const data = useAsyncData(getVersion, []);
  const { pathname, hash } = useLocation();
  const isSettingsRoute = Boolean(useMatch("/dashboard/settings/*"));
  const reduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousPath = useRef(pathname);

  useLayoutEffect(() => {
    // Previously a route change remounted this scrolling element, putting a
    // new settings page at the top. Retaining the settings shell must preserve
    // that behavior without interrupting a deep link's own anchor scroll.
    if (
      isSettingsRoute &&
      previousPath.current !== pathname &&
      !hash &&
      contentRef.current
    ) {
      contentRef.current.scrollTop = 0;
    }
    previousPath.current = pathname;
  }, [pathname, hash, isSettingsRoute]);

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
          {/* Enter only: retaining an outgoing Outlet during an exit animation
              makes it follow the new route and run cleanup on the incoming page.
              Key by pathname so query-only navigation keeps the page mounted.
              Settings is one persistent shell with its own routed pages: keep
              the shell and its focused rail mounted across section changes. */}
          <Box
            component={motion.div}
            ref={contentRef}
            key={isSettingsRoute ? "/dashboard/settings" : pathname}
            initial={reduceMotion ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
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

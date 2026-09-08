/**
 * DashboardMenu — recreated shell around REAL ListTile + MorphNavIcon.
 *
 * Why recreated: the real DashboardMenu reads the zustand store
 * (assistant-mode flag, update availability) and useLocation/useNavigate for
 * app routes. The rail wash, geometry, and the shared-layout active
 * indicator are copied verbatim from components/dashboard/DashboardMenu.tsx;
 * rows render the real ListTile and real MorphNavIcon, so those halves stay
 * pixel-identical by construction.
 */
import { Box, List, Stack, useColorScheme } from "@mui/material";
import { motion, useReducedMotion } from "framer-motion";
import { House, MessagesSquare, Mic, Settings, Shapes } from "lucide";
import { useState } from "react";
import { ListTile } from "@desktop/components/common/ListTile";
import { MorphNavIcon } from "@desktop/components/common/MorphNavIcon";
import { springSnappy } from "@desktop/styles/motion";
import { inkSolid, surfaceAlpha, surfaces } from "@desktop/styles/palette";
import { hairline, premiumSurface } from "@desktop/styles/shadows";
import { useSpecValue } from "../lib/spec-store";

const NAV = [
  { label: "Home", path: "/home", icon: House },
  { label: "Chats", path: "/chats", icon: MessagesSquare },
  { label: "Transcriptions", path: "/transcriptions", icon: Mic },
  { label: "Styling", path: "/styling", icon: Shapes },
];

export const DashboardMenuPreview = ({
  initial = "/home",
  showUpdate = false,
}: {
  initial?: string;
  showUpdate?: boolean;
}) => {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;
  const dark = resolved === "dark";
  const reduceMotion = useReducedMotion();
  const [path, setPath] = useState(initial);
  const indicatorRadius = useSpecValue("dashboard-menu", "indicator-radius", 14);

  const selectedShadow = dark ? premiumSurface.dark.selected : premiumSurface.light.selected;

  const activeIndicator = (selected: boolean) => {
    if (!selected) return null;
    const sx = {
      position: "absolute",
      inset: 0,
      borderRadius: `${indicatorRadius}px`,
      bgcolor: dark ? surfaces.dark.level2 : inkSolid.base,
      boxShadow: selectedShadow,
      zIndex: 0,
      pointerEvents: "none",
    } as const;
    if (reduceMotion) return <Box sx={sx} />;
    return <Box component={motion.div} layoutId="sidebar-active" transition={springSnappy} sx={sx} />;
  };

  const tileSx = {
    mb: 0.5,
    "& .MuiListItemButton-root": {
      "&.Mui-selected": { backgroundColor: "transparent", boxShadow: "none" },
      "&.Mui-selected:hover": { backgroundColor: "transparent" },
    },
  };

  return (
    <Stack
      sx={{
        alignItems: "stretch",
        height: 420,
        width: 232,
        borderRadius: "16px",
        margin: "0.35rem",
        border: dark ? hairline.dark(0.05) : hairline.light(0.05),
        background: dark
          ? `linear-gradient(180deg, ${surfaceAlpha(surfaces.dark.level2, 0.55)} 0%, ${surfaceAlpha(surfaces.dark.level0, 0.2)} 100%)`
          : `linear-gradient(180deg, ${surfaceAlpha(surfaces.light.level1, 0.7)} 0%, ${surfaceAlpha(surfaces.light.level0, 0.35)} 100%)`,
      }}
    >
      <Box sx={{ flexGrow: 1, overflowY: "auto", pt: 0.5 }}>
        <List sx={{ px: 1.5, pb: 2, pt: 0.5 }}>
          {NAV.map(({ label, path: p, icon }) => (
            <ListTile
              key={p}
              onClick={() => setPath(p)}
              selected={path === p}
              leading={<MorphNavIcon icon={icon} />}
              title={label}
              disableRipple
              indicator={activeIndicator(path === p)}
              sx={tileSx}
            />
          ))}
        </List>
      </Box>
      <Box sx={{ mt: 1, p: 1.5, pt: 0 }}>
        {showUpdate && (
          <ListTile
            leading={<MorphNavIcon icon={Shapes} />}
            title="Update available"
            disableRipple
            sx={{ mb: 0.5 }}
          />
        )}
        <ListTile
          onClick={() => setPath("/settings")}
          selected={path === "/settings"}
          leading={<MorphNavIcon icon={Settings} />}
          title="Settings"
          disableRipple
          indicator={activeIndicator(path === "/settings")}
          sx={{
            "& .MuiListItemButton-root": {
              "&.Mui-selected": { backgroundColor: "transparent", boxShadow: "none" },
              "&.Mui-selected:hover": { backgroundColor: "transparent" },
            },
          }}
        />
      </Box>
    </Stack>
  );
};

import { Box, List, Stack, useColorScheme } from "@mui/material";
import { motion, useReducedMotion } from "framer-motion";
import {
  BookMarked,
  History,
  Home,
  MessageSquare,
  Palette,
  Settings,
  type IconNode,
} from "lucide";
import { useMemo } from "react";
import { FormattedMessage } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "../../store";
import { springSnappy } from "../../styles/motion";
import { inkSolid, surfaceAlpha, surfaces } from "../../styles/palette";
import { hairline, premiumSurface } from "../../styles/shadows";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { ListTile } from "../common/ListTile";
import { MorphNavIcon } from "../common/MorphNavIcon";
import { UpdateListTile } from "./UpdateListTile";

const settingsPath = "/dashboard/settings";

type NavItem = {
  label: React.ReactNode;
  path: string;
  icon: IconNode;
};

export type DashboardMenuProps = {
  onChoose?: () => void;
};

export const DashboardMenu = ({ onChoose }: DashboardMenuProps) => {
  const location = useLocation();
  const nav = useNavigate();
  const reduceMotion = useReducedMotion();
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;
  const dark = resolved === "dark";

  const isUpdateAvailable = useAppStore(
    (state) => state.updater.status === "ready",
  );
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);

  const navItems = useMemo<NavItem[]>(
    () => [
      {
        label: <FormattedMessage defaultMessage="Home" />,
        path: "/dashboard",
        icon: Home,
      },
      {
        label: <FormattedMessage defaultMessage="History" />,
        path: "/dashboard/transcriptions",
        icon: History,
      },
      {
        label: <FormattedMessage defaultMessage="Dictionary" />,
        path: "/dashboard/dictionary",
        icon: BookMarked,
      },
      {
        label: <FormattedMessage defaultMessage="Styles" />,
        path: "/dashboard/styling",
        icon: Palette,
      },
      ...(assistantModeEnabled
        ? [
            {
              label: <FormattedMessage defaultMessage="Chats" />,
              path: "/dashboard/chats",
              icon: MessageSquare,
            },
          ]
        : []),
    ],
    [assistantModeEnabled],
  );

  const onChooseHandler = (path: string) => {
    onChoose?.();
    nav(path);
  };

  const isSelected = (path: string) => {
    if (path === "/dashboard") {
      return location.pathname === "/dashboard";
    }
    return (
      location.pathname === path || location.pathname.startsWith(`${path}/`)
    );
  };

  const selectedShadow = dark
    ? premiumSurface.dark.selected
    : premiumSurface.light.selected;

  const activeIndicator = (selected: boolean) => {
    if (!selected) return null;
    if (reduceMotion) {
      return (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            borderRadius: 1,
            bgcolor: dark ? surfaces.dark.level2 : inkSolid.base,
            boxShadow: selectedShadow,
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      );
    }
    return (
      <Box
        component={motion.div}
        layoutId="sidebar-active"
        transition={springSnappy}
        sx={{
          position: "absolute",
          inset: 0,
          borderRadius: 1,
          bgcolor: dark ? surfaces.dark.level2 : inkSolid.base,
          boxShadow: selectedShadow,
          zIndex: 0,
          pointerEvents: "none",
        }}
      />
    );
  };

  const list = (
    <List sx={{ px: 1.5, pb: 2, pt: 0.5 }}>
      {navItems.map(({ label, path, icon }) => {
        const selected = isSelected(path);
        return (
          <ListTile
            key={path}
            onClick={() => onChooseHandler(path)}
            selected={selected}
            leading={<MorphNavIcon icon={icon} />}
            title={label}
            disableRipple
            indicator={activeIndicator(selected)}
            sx={{
              mb: 0.5,
              "& .MuiListItemButton-root": {
                "&.Mui-selected": {
                  backgroundColor: "transparent",
                  boxShadow: "none",
                },
                "&.Mui-selected:hover": {
                  backgroundColor: "transparent",
                },
              },
            }}
          />
        );
      })}
    </List>
  );

  const settingsSelected = isSelected(settingsPath);

  return (
    <Stack
      sx={{
        alignItems: "stretch",
        height: "100%",
        borderRadius: 1,
        margin: "0.35rem",
        border: dark ? hairline.dark(0.05) : hairline.light(0.05),

        // Rail wash: one tier of lift at the top settling back into the canvas,
        // derived from the surface ladder rather than one-off hexes.
        background: dark
          ? `linear-gradient(180deg, ${surfaceAlpha(surfaces.dark.level2, 0.55)} 0%, ${surfaceAlpha(surfaces.dark.level0, 0.2)} 100%)`
          : `linear-gradient(180deg, ${surfaceAlpha(surfaces.light.level1, 0.7)} 0%, ${surfaceAlpha(surfaces.light.level0, 0.35)} 100%)`,
      }}
    >
      <Box sx={{ flexGrow: 1, overflowY: "auto", pt: 0.5 }}>{list}</Box>
      <Box sx={{ mt: 1, p: 1.5, pt: 0 }}>
        {isUpdateAvailable && <UpdateListTile />}
        <ListTile
          key={settingsPath}
          onClick={() => onChooseHandler(settingsPath)}
          selected={settingsSelected}
          leading={<MorphNavIcon icon={Settings} />}
          title={<FormattedMessage defaultMessage="Settings" />}
          disableRipple
          indicator={activeIndicator(settingsSelected)}
          sx={{
            "& .MuiListItemButton-root": {
              "&.Mui-selected": {
                backgroundColor: "transparent",
                boxShadow: "none",
              },
              "&.Mui-selected:hover": {
                backgroundColor: "transparent",
              },
            },
          }}
        />
      </Box>
    </Stack>
  );
};

import { Box, List, Stack } from "@mui/material";
import { motion, useReducedMotion } from "framer-motion";
import {
  BookMarked,
  CircleHelp,
  History,
  Home,
  MessageSquare,
  Palette,
  Settings,
  type IconNode,
} from "lucide";
import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import { useIsDarkMode } from "../../hooks/color-scheme.hooks";
import { useAppStore } from "../../store";
import { springSnappy } from "../../styles/motion";
import { chromeWash, inkSolid, surfaces } from "../../styles/palette";
import {
  hairline,
  insetRim,
  premiumSurface,
  raisedEdge,
} from "../../styles/shadows";
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
  const intl = useIntl();
  const nav = useNavigate();
  const reduceMotion = useReducedMotion();
  const dark = useIsDarkMode();

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
      {
        label: <FormattedMessage defaultMessage="Help" />,
        path: "/dashboard/help",
        icon: CircleHelp,
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
    <List
      aria-label={intl.formatMessage({ defaultMessage: "Pages" })}
      sx={{ px: 1.5, pb: 2, pt: 0.5 }}
    >
      {navItems.map(({ label, path, icon }) => {
        const selected = isSelected(path);
        return (
          <ListTile
            key={path}
            component="li"
            onClick={() => onChooseHandler(path)}
            selected={selected}
            ariaCurrent={selected ? "page" : undefined}
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
      component="nav"
      aria-label={intl.formatMessage({
        defaultMessage: "Dashboard navigation",
      })}
      sx={{
        alignItems: "stretch",
        height: "100%",
        // Flush against the window's left edge and full height, rounded only where the
        // rail faces the page. Rounding all four corners left a notch against
        // the window frame and made the rail read as a floating card that
        // happened to be clipped, rather than the edge of a plane.
        borderRadius: "0 16px 16px 0",
        // Only the edge that faces content carries a hairline. The other three
        // run into the window frame or into bare canvas, where a 1px line has
        // nothing to separate and reads as an artifact.
        borderRight: dark ? hairline.dark(0.05) : hairline.light(0.05),
        // Same wash as the title bar and the content panel, so all three read as
        // one material standing off the canvas. The rail is not contiguous with
        // the bar: the page header sits between them, so this is shared paint,
        // not one continuous L-shaped surface. The rim catches light along the
        // top edge and `raisedEdge` casts along the one edge that faces content.
        boxShadow: dark
          ? `${insetRim.dark}, ${raisedEdge.dark}`
          : `${insetRim.light}, ${raisedEdge.light}`,
        background: dark ? chromeWash.dark : chromeWash.light,
      }}
    >
      <Box sx={{ flexGrow: 1, overflowY: "auto", pt: 0.5 }}>{list}</Box>
      <Box sx={{ mt: 1, p: 1.5, pt: 0 }}>
        {isUpdateAvailable && <UpdateListTile />}
        <List
          aria-label={intl.formatMessage({ defaultMessage: "Settings" })}
          disablePadding
        >
          <ListTile
            key={settingsPath}
            component="li"
            onClick={() => onChooseHandler(settingsPath)}
            selected={settingsSelected}
            ariaCurrent={settingsSelected ? "page" : undefined}
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
        </List>
      </Box>
    </Stack>
  );
};

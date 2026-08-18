import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Typography,
  useColorScheme,
} from "@mui/material";
import {
  Monitor as MonitorNode,
  Moon as MoonNode,
  Sun as SunNode,
  type IconNode,
} from "lucide";
import { MorphIcon } from "morphicons/react";
import { useCallback, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

type ThemeChoice = "light" | "dark" | "system";

function getMorphIcon(choice: ThemeChoice): IconNode {
  if (choice === "dark") return MoonNode;
  if (choice === "light") return SunNode;
  return MonitorNode;
}

const menuItemSx = {
  py: 1,
  px: 1.5,
  borderRadius: 1.5,
  mx: 0.5,
  my: 0.25,
  gap: 1.25,
  "&.Mui-selected": {
    backgroundColor: "action.selected",
  },
} as const;

export const ThemeModeToggle = () => {
  const { mode, setMode } = useColorScheme();
  const intl = useIntl();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleOpen = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(e.currentTarget);
  }, []);

  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handleSelect = useCallback(
    (choice: ThemeChoice) => {
      setMode(choice);
      handleClose();
    },
    [setMode, handleClose],
  );

  const activeChoice: ThemeChoice =
    mode === "light" || mode === "dark" || mode === "system" ? mode : "system";

  const morphIcon = useMemo(() => getMorphIcon(activeChoice), [activeChoice]);

  const ariaLabel = intl.formatMessage({
    defaultMessage: "Theme settings",
  });
  const tooltipTitle = intl.formatMessage(
    { defaultMessage: "Theme: {mode}" },
    { mode: activeChoice },
  );

  return (
    <>
      <IconButton
        onClick={handleOpen}
        aria-label={ariaLabel}
        size="small"
        title={tooltipTitle}
        sx={{
          width: 28,
          height: 28,
          borderRadius: 1.5,
          color: "text.secondary",
          // Motion per DESIGN.md: 120-180ms ease-out, no spring-bounce on tools.
          transition: (theme) =>
            theme.transitions.create(
              ["background-color", "color", "transform"],
              {
                duration: 150,
                easing: theme.transitions.easing.easeOut,
              },
            ),
          "&:hover": { backgroundColor: "action.hover", color: "text.primary" },
          "&:active": { transform: "scale(0.94)" },
        }}
      >
        {/*
          `snappy` is the least bouncy MorphIcon spring, which keeps the icon
          transition in line with the "no spring-bounce on a tool" motion rule.
        */}
        <MorphIcon
          icon={morphIcon}
          size={18}
          strokeWidth={1.9}
          spring="snappy"
        />
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{
          paper: {
            sx: {
              minWidth: 140,
              mt: 0.5,
              borderRadius: 2,
            },
          },
        }}
      >
        <MenuItem
          onClick={() => handleSelect("light")}
          selected={activeChoice === "light"}
          sx={menuItemSx}
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              alignItems: "center",
              flex: 1,
            }}
          >
            <Sun size={16} strokeWidth={1.9} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
              }}
            >
              <FormattedMessage defaultMessage="Light" />
            </Typography>
          </Stack>
          {activeChoice === "light" && (
            <Check size={16} strokeWidth={1.9} />
          )}
        </MenuItem>
        <MenuItem
          onClick={() => handleSelect("dark")}
          selected={activeChoice === "dark"}
          sx={menuItemSx}
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              alignItems: "center",
              flex: 1,
            }}
          >
            <Moon size={16} strokeWidth={1.9} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
              }}
            >
              <FormattedMessage defaultMessage="Dark" />
            </Typography>
          </Stack>
          {activeChoice === "dark" && (
            <Check size={16} strokeWidth={1.9} />
          )}
        </MenuItem>
        <MenuItem
          onClick={() => handleSelect("system")}
          selected={activeChoice === "system"}
          sx={menuItemSx}
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              alignItems: "center",
              flex: 1,
            }}
          >
            <Monitor size={16} strokeWidth={1.9} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
              }}
            >
              <FormattedMessage defaultMessage="System" />
            </Typography>
          </Stack>
          {activeChoice === "system" && (
            <Check size={16} strokeWidth={1.9} />
          )}
        </MenuItem>
      </Menu>
    </>
  );
};

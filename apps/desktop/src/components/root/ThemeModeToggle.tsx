import {
  Check,
  DarkMode,
  LightMode,
  SettingsBrightness,
} from "@mui/icons-material";
import {
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Typography,
  useColorScheme,
} from "@mui/material";
import { Moon, Sun, Monitor } from "lucide";
import type { IconNode } from "lucide";
import { MorphIcon } from "morphicons/react";
import { useCallback, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

type ThemeChoice = "light" | "dark" | "system";

function getMorphIcon(choice: ThemeChoice): IconNode {
  if (choice === "dark") return Moon;
  if (choice === "light") return Sun;
  return Monitor;
}

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

  const label = intl.formatMessage({
    defaultMessage: "Theme settings",
    description: "aria-label for the theme mode toggle button",
  });
  const title = intl.formatMessage(
    {
      defaultMessage: "Theme: {mode}",
      description: "tooltip showing the current theme mode",
    },
    { mode: activeChoice },
  );

  const choices: {
    value: ThemeChoice;
    labelId: string;
    defaultLabel: string;
    icon: React.ReactNode;
  }[] = [
    {
      value: "light",
      labelId: "theme.light",
      defaultLabel: "Light",
      icon: <LightMode sx={{ fontSize: 16 }} />,
    },
    {
      value: "dark",
      labelId: "theme.dark",
      defaultLabel: "Dark",
      icon: <DarkMode sx={{ fontSize: 16 }} />,
    },
    {
      value: "system",
      labelId: "theme.system",
      defaultLabel: "System",
      icon: <SettingsBrightness sx={{ fontSize: 16 }} />,
    },
  ];

  return (
    <>
      <IconButton
        onClick={handleOpen}
        aria-label={label}
        size="small"
        title={title}
        sx={{
          width: 28,
          height: 28,
          borderRadius: 1.5,
          color: "text.secondary",
          "&:hover": { backgroundColor: "action.hover" },
        }}
      >
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
        {choices.map((choice) => (
          <MenuItem
            key={choice.value}
            onClick={() => handleSelect(choice.value)}
            selected={choice.value === activeChoice}
            sx={{
              py: 1,
              px: 1.5,
              borderRadius: 1.5,
              mx: 0.5,
              my: 0.25,
              gap: 1.25,
              "&.Mui-selected": {
                backgroundColor: "action.selected",
              },
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              spacing={1.25}
              sx={{ flex: 1 }}
            >
              {choice.icon}
              <Typography variant="body2" fontWeight={500}>
                <FormattedMessage defaultMessage={choice.defaultLabel} />
              </Typography>
            </Stack>
            {choice.value === activeChoice && (
              <Check sx={{ fontSize: 16, color: "text.secondary" }} />
            )}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};

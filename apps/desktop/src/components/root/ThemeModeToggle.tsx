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
import { MorphIcon } from "morphicons/react";
import { useCallback, useMemo, useState } from "react";

type ThemeChoice = "light" | "dark" | "system";

const choices: { value: ThemeChoice; label: string; icon: React.ReactNode }[] =
  [
    {
      value: "light",
      label: "Light",
      icon: <LightMode sx={{ fontSize: 16 }} />,
    },
    { value: "dark", label: "Dark", icon: <DarkMode sx={{ fontSize: 16 }} /> },
    {
      value: "system",
      label: "System",
      icon: <SettingsBrightness sx={{ fontSize: 16 }} />,
    },
  ];

export const ThemeModeToggle = () => {
  const { mode, setMode } = useColorScheme();
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

  const morphIcon = useMemo(
    () =>
      activeChoice === "dark" ? Moon : activeChoice === "light" ? Sun : Monitor,
    [activeChoice],
  );

  return (
    <>
      <IconButton
        onClick={handleOpen}
        aria-label="Theme settings"
        size="small"
        title={`Theme: ${activeChoice}`}
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
                {choice.label}
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

import { createTheme, type Shadows } from "@mui/material/styles";
import { premiumSurface } from "./styles/shadows";

const uiFont = '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif';
const displayFont = '"TAN-PARADISO", "Plus Jakarta Sans", system-ui, sans-serif';

export const theme = createTheme({
  cssVariables: {
    cssVarPrefix: "app",
  },

  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#12151C" },
        secondary: { main: "#404040" },

        goldFg: "rgb(104, 48, 9)",
        goldBg: "rgba(255, 193, 7, 0.6)",
        shadow: "rgba(15, 18, 25, 0.12)",
        blue: "#1b8af8ff",
        blueHover: "#1a7cd4ff",
        blueActive: "#166bbf",
        onBlue: "#FFFFFF",

        level0: "#F4F5F7",
        level1: "#FFFFFF",
        level2: "#ECEEF2",
        level3: "#E0E3E9",
      },
    },
    dark: {
      palette: {
        primary: { main: "#FFFFFF", light: "#E8EAED" },
        secondary: { main: "#B3B3B3" },

        goldFg: "#FFD700",
        goldBg: "rgba(255, 215, 0, 0.2)",
        shadow: "rgba(0, 0, 0, 0.5)",
        blue: "#3198ffff",
        blueHover: "#2787e6ff",
        blueActive: "#1f76cc",
        onBlue: "#FFFFFF",

        level0: "#0B0C0F",
        level1: "#14161B",
        level2: "#1E2128",
        level3: "#2A2E38",
      },
    },
  },

  shape: { borderRadius: 14 },

  shadows: Array(25).fill("none") as unknown[] as Shadows,

  typography: {
    fontFamily: uiFont,
    pxToRem: (px: number) => `${px / 16}rem`,

    displayLarge: {
      fontFamily: displayFont,
      fontSize: 57,
      lineHeight: 1.05,
      fontWeight: 500,
      letterSpacing: "-0.02em",
    },
    displayMedium: {
      fontFamily: displayFont,
      fontSize: 45,
      lineHeight: 1.08,
      fontWeight: 500,
      letterSpacing: "-0.02em",
    },
    displaySmall: {
      fontFamily: displayFont,
      fontSize: 36,
      lineHeight: 1.1,
      fontWeight: 500,
      letterSpacing: "-0.015em",
    },

    headlineLarge: { fontSize: 32, lineHeight: 1.15, fontWeight: 600 },
    headlineMedium: { fontSize: 28, lineHeight: 1.2, fontWeight: 600 },
    headlineSmall: { fontSize: 24, lineHeight: 1.25, fontWeight: 600 },

    titleLarge: { fontSize: 22, lineHeight: 1.3, fontWeight: 600 },
    titleMedium: { fontSize: 17, lineHeight: 1.35, fontWeight: 600 },
    titleSmall: { fontSize: 15, lineHeight: 1.35, fontWeight: 600 },

    bodyLarge: { fontSize: 17, lineHeight: 1.5, fontWeight: 400 },
    bodyMedium: { fontSize: 15, lineHeight: 1.5, fontWeight: 400 },
    bodySmall: { fontSize: 13, lineHeight: 1.45, fontWeight: 400 },

    labelLarge: { fontSize: 15, lineHeight: 1.3, fontWeight: 600 },
    labelMedium: { fontSize: 13, lineHeight: 1.3, fontWeight: 600 },
    labelSmall: { fontSize: 12, lineHeight: 1.3, fontWeight: 600 },

    h5: {
      fontFamily: displayFont,
      fontWeight: 600,
      letterSpacing: "-0.02em",
    },
    body1: { fontSize: 15, lineHeight: 1.55, fontWeight: 400 },
    body2: { fontSize: 13.5, lineHeight: 1.5, fontWeight: 400 },
    button: { fontWeight: 600, letterSpacing: "0.01em" },
  },

  transitions: {
    easing: {
      easeOut: "cubic-bezier(0.23, 1, 0.32, 1)",
      easeInOut: "cubic-bezier(0.645, 0.045, 0.355, 1)",
      sharp: "cubic-bezier(0.33, 1, 0.68, 1)",
    },
    duration: {
      shortest: 100,
      shorter: 150,
      short: 180,
      standard: 220,
      complex: 280,
      enteringScreen: 250,
      leavingScreen: 180,
    },
  },

  components: {
    MuiCssBaseline: {
      styleOverrides: (themeParam) => ({
        "*, *::before, *::after": {
          boxSizing: "border-box",
        },
        html: {
          height: "100%",
        },
        body: {
          height: "100%",
          margin: 0,
          backgroundColor: themeParam.vars.palette.level0,
          color: themeParam.vars.palette.text?.primary,
          fontFamily: uiFont,
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
          textRendering: "optimizeLegibility",
          transition: "background-color 220ms cubic-bezier(0.23, 1, 0.32, 1)",
        },
        "#root": {
          height: "100%",
        },
        "@media (prefers-reduced-motion: reduce)": {
          "*, *::before, *::after": {
            animationDuration: "0.01ms !important",
            animationIterationCount: "1 !important",
            transitionDuration: "0.01ms !important",
            scrollBehavior: "auto !important",
          },
        },
      }),
    },

    MuiDialog: {
      styleOverrides: {
        paper: ({ theme }) => ({
          backgroundColor: theme.vars.palette.level1,
          backgroundImage: "none",
          borderRadius: 18,
          boxShadow:
            theme.palette.mode === "dark"
              ? premiumSurface.dark.hover
              : premiumSurface.light.hover,
          border: `1px solid ${
            theme.palette.mode === "dark"
              ? "rgba(255,255,255,0.06)"
              : "rgba(15,18,25,0.06)"
          }`,
        }),
      },
    },

    MuiDialogActions: {
      styleOverrides: {
        root: ({ theme }) => ({
          padding: theme.spacing(3),
          paddingTop: theme.spacing(2),
          paddingBottom: theme.spacing(2),
        }),
      },
    },

    MuiTooltip: {
      styleOverrides: {
        tooltip: ({ theme }) => ({
          fontSize: theme.typography.pxToRem(13),
          fontWeight: 550,
          borderRadius: 10,
          padding: "8px 12px",
          boxShadow:
            theme.palette.mode === "dark"
              ? premiumSurface.dark.rest
              : premiumSurface.light.rest,
        }),
      },
    },

    MuiSwitch: {
      styleOverrides: {
        switchBase: ({ theme }) => ({
          "&.Mui-checked": {
            color: theme.vars.palette.blue,
            "& + .MuiSwitch-track": {
              backgroundColor: theme.vars.palette.blue,
            },
          },
        }),
        track: ({ theme }) => ({
          ".Mui-checked.Mui-checked + &": {
            backgroundColor: theme.vars.palette.blue,
          },
        }),
      },
    },

    MuiFab: {
      styleOverrides: {
        root: ({ theme }) => ({
          textTransform: "none",
          fontSize: theme.typography.pxToRem(18),
          borderRadius: 99,
          padding: theme.spacing(2, 3),
          boxShadow:
            theme.palette.mode === "dark"
              ? premiumSurface.dark.rest
              : premiumSurface.light.rest,
          transition:
            "transform 150ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1)",
          "&:hover": {
            transform: "translateY(-1px)",
            boxShadow:
              theme.palette.mode === "dark"
                ? premiumSurface.dark.hover
                : premiumSurface.light.hover,
          },
          "&:active": {
            transform: "scale(0.98)",
            boxShadow:
              theme.palette.mode === "dark"
                ? premiumSurface.dark.active
                : premiumSurface.light.active,
          },
          "& .MuiSvgIcon-root": {
            fontSize: 26,
          },
          "&.MuiFab-info": {
            backgroundColor: theme.vars.palette.level2,
            color: theme.vars.palette.text.primary,
            "&:hover": {
              backgroundColor: theme.vars.palette.level3,
            },
          },
        }),
      },
    },

    MuiAccordion: {
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: theme.vars.palette.level1,
          borderRadius: theme.shape.borderRadius,
          boxShadow:
            theme.palette.mode === "dark"
              ? premiumSurface.dark.rest
              : premiumSurface.light.rest,
          "&:before": {
            display: "none",
          },
          "&.Mui-expanded": {
            margin: "auto",
          },
        }),
        rounded: ({ theme }) => ({
          borderRadius: theme.shape.borderRadius,
        }),
      },
    },

    MuiPopover: {
      styleOverrides: {
        paper: ({ theme }) => ({
          backgroundColor: theme.vars.palette.level1,
          backgroundImage: "none",
          borderRadius: 14,
          border: `1px solid ${
            theme.palette.mode === "dark"
              ? "rgba(255,255,255,0.06)"
              : "rgba(15,18,25,0.06)"
          }`,
          boxShadow:
            theme.palette.mode === "dark"
              ? premiumSurface.dark.hover
              : premiumSurface.light.hover,
        }),
      },
    },

    MuiAccordionSummary: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontSize: theme.typography.pxToRem(15),
          fontWeight: 600,
          color: theme.vars.palette.text.primary,
        }),
      },
    },

    MuiAccordionDetails: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontSize: theme.typography.pxToRem(14),
          color: theme.vars.palette.text.secondary,
        }),
      },
    },

    MuiButton: {
      defaultProps: { disableElevation: true, disableRipple: true },
      styleOverrides: {
        root: ({ theme }) => ({
          textTransform: "none",
          fontWeight: 600,
          borderRadius: 12,
          fontSize: theme.typography.pxToRem(15),
          padding: theme.spacing(1, 2),
          transition:
            "transform 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 180ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1), color 180ms cubic-bezier(0.23, 1, 0.32, 1)",
          "& .MuiSvgIcon-root": {
            fontSize: 22,
          },
          "&:active": {
            transform: "scale(0.98)",
          },
        }),
        text: ({ theme }) => ({
          color: theme.vars.palette.primary.main,
          "&:hover": {
            backgroundColor: theme.vars.palette.level2,
          },
          "&:active": {
            backgroundColor: theme.vars.palette.level3,
          },
        }),
        contained: ({ theme }) => {
          const dark = theme.palette.mode === "dark";
          return {
            color: dark ? "#0B0C0F" : "#FFFFFF",
            backgroundColor: dark ? "#FFFFFF" : "#12151C",
            boxShadow: dark
              ? premiumSurface.dark.rest
              : premiumSurface.light.rest,
            "&:hover": {
              backgroundColor: dark ? "#F0F2F5" : "#1C2230",
              boxShadow: dark
                ? premiumSurface.dark.hover
                : premiumSurface.light.hover,
              transform: "translateY(-1px)",
            },
            "&:active": {
              transform: "scale(0.98) translateY(0)",
              boxShadow: dark
                ? premiumSurface.dark.active
                : premiumSurface.light.active,
              backgroundColor: dark ? "#FFFFFF" : "#0E1118",
            },
          };
        },
      },
      variants: [
        {
          props: { variant: "flat" },
          style: ({ theme }) => {
            const dark = theme.palette.mode === "dark";
            return {
              backgroundColor: theme.vars.palette.level1,
              color: theme.vars.palette.primary.main,
              boxShadow: dark
                ? premiumSurface.dark.rest
                : premiumSurface.light.rest,
              "&:hover": {
                backgroundColor: theme.vars.palette.level2,
                boxShadow: dark
                  ? premiumSurface.dark.hover
                  : premiumSurface.light.hover,
                transform: "translateY(-1px)",
              },
              "&:active": {
                backgroundColor: theme.vars.palette.level3,
                transform: "scale(0.98) translateY(0)",
                boxShadow: dark
                  ? premiumSurface.dark.active
                  : premiumSurface.light.active,
              },
              fontSize: theme.typography.pxToRem(15),
              "& .MuiButton-startIcon > .MuiSvgIcon-root, \
    & .MuiButton-endIcon  > .MuiSvgIcon-root": {
                fontSize: 22,
              },
            };
          },
        },
        {
          props: { variant: "blue" },
          style: ({ theme }) => ({
            backgroundColor: theme.vars.palette.blue,
            color: theme.vars.palette.onBlue,
            boxShadow: `
              inset 0 1px 0 rgba(255,255,255,0.28),
              inset 0 2px 0 rgba(255,255,255,0.1),
              0 6px 16px rgba(27, 138, 248, 0.35)
            `,
            "&:hover": {
              backgroundColor: theme.vars.palette.blueHover,
              transform: "translateY(-1px)",
            },
            "&:active": {
              backgroundColor: theme.vars.palette.blueActive,
              transform: "scale(0.98) translateY(0)",
            },
          }),
        },
      ],
    },

    MuiPaper: {
      defaultProps: { elevation: 0, variant: "flat" },
      styleOverrides: {
        outlined: ({ theme }) => ({
          backgroundColor: theme.vars.palette.level1,
          border: `1px solid ${
            theme.palette.mode === "dark"
              ? "rgba(255,255,255,0.08)"
              : "rgba(15,18,25,0.08)"
          }`,
        }),
      },
      variants: [
        {
          props: { variant: "flat" },
          style: ({ theme }) => {
            const dark = theme.palette.mode === "dark";
            return {
              backgroundColor: theme.vars.palette.level1,
              boxShadow: dark
                ? premiumSurface.dark.rest
                : premiumSurface.light.rest,
              border: `1px solid ${
                dark ? "rgba(255,255,255,0.04)" : "rgba(15,18,25,0.04)"
              }`,
              transition:
                "transform 180ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1)",
            };
          },
        },
      ],
    },

    MuiStepLabel: {
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: "transparent",
          fontSize: theme.typography.pxToRem(15),
        }),
        vertical: ({ theme }) => ({
          backgroundColor: "transparent",
          fontSize: theme.typography.pxToRem(15),
        }),
      },
    },

    MuiIconButton: {
      defaultProps: { disableRipple: true },
      styleOverrides: {
        root: ({ theme }) => ({
          color: theme.vars.palette.text.primary,
          borderRadius: 12,
          transition:
            "transform 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 180ms cubic-bezier(0.23, 1, 0.32, 1)",
          "&:hover": {
            backgroundColor: theme.vars.palette.level2,
          },
          "&:active": {
            transform: "scale(0.96)",
          },
        }),
      },
    },

    MuiCard: {
      defaultProps: { variant: "flat", elevation: 0 },
      styleOverrides: {
        root: ({ theme }) => {
          const dark = theme.palette.mode === "dark";
          return {
            backgroundColor: theme.vars.palette.level1,
            borderRadius: 16,
            border: `1px solid ${
              dark ? "rgba(255,255,255,0.05)" : "rgba(15,18,25,0.05)"
            }`,
            boxShadow: dark
              ? premiumSurface.dark.rest
              : premiumSurface.light.rest,
            transition:
              "transform 180ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1)",
            "&:hover": {
              transform: "translateY(-1px)",
              boxShadow: dark
                ? premiumSurface.dark.hover
                : premiumSurface.light.hover,
            },
          };
        },
      },
      variants: [
        {
          props: { variant: "flat" },
          style: ({ theme }) => ({
            backgroundColor: theme.vars.palette.level1,
          }),
        },
      ],
    },

    MuiListItemButton: {
      defaultProps: { disableRipple: true },
      styleOverrides: {
        root: ({ theme }) => {
          const dark = theme.palette.mode === "dark";
          return {
            borderRadius: 14,
            marginBottom: 4,
            minHeight: 44,
            paddingTop: 10,
            paddingBottom: 10,
            transition:
              "transform 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 180ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1), color 180ms cubic-bezier(0.23, 1, 0.32, 1)",
            "&:hover": {
              backgroundColor: dark
                ? "rgba(255,255,255,0.04)"
                : "rgba(15,18,25,0.04)",
            },
            "&:active": {
              transform: "scale(0.985)",
            },
            "&.Mui-selected": {
              backgroundColor: dark ? "#1A1D24" : "#12151C",
              color: "#FFFFFF",
              boxShadow: dark
                ? premiumSurface.dark.selected
                : premiumSurface.light.selected,
              "&:hover": {
                backgroundColor: dark ? "#22262F" : "#1A1F2A",
              },
              "& .MuiListItemText-primary": {
                color: "#FFFFFF",
                fontWeight: 650,
              },
              "& .MuiListItemText-secondary": {
                color: "rgba(255,255,255,0.72)",
              },
              "& .MuiSvgIcon-root": {
                color: "#FFFFFF",
              },
            },
          };
        },
      },
    },

    MuiListItemText: {
      styleOverrides: {
        primary: {
          fontWeight: 550,
          fontSize: "0.9375rem",
          letterSpacing: "-0.01em",
        },
      },
    },

    MuiToggleButton: {
      styleOverrides: {
        root: () => ({
          textTransform: "none",
          borderRadius: 12,
          fontWeight: 600,
        }),
      },
    },
  },
});

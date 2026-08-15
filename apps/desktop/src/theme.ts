import { createTheme, type Shadows } from "@mui/material/styles";
import {
  accent,
  chalkSolid,
  darkInk,
  highlight,
  ink,
  inkSolid,
  surfaces,
  text,
} from "./styles/palette";
import { hairline, premiumSurface } from "./styles/shadows";

const uiFont = '"Satoshi", system-ui, -apple-system, sans-serif';
/** TAN-PARADISO only via CSS var(--font-display) on logo + welcome/name. */

export const THEME_MODE_STORAGE_KEY = "mui-mode";
export const THEME_COLOR_SCHEME_SELECTOR = "data-mui-color-scheme";
export const THEME_PROVIDER_CONFIG = {
  defaultMode: "system",
  modeStorageKey: THEME_MODE_STORAGE_KEY,
} as const;

export const theme = createTheme({
  cssVariables: {
    cssVarPrefix: "app",
    colorSchemeSelector: THEME_COLOR_SCHEME_SELECTOR,
  },

  colorSchemes: {
    light: {
      palette: {
        primary: { main: inkSolid.base },
        secondary: { main: "#4A443C" },
        text: text.light,
        divider: ink(0.08),

        // Route MUI's built-in background tokens through the surface ladder so
        // components that read `background.default` / `background.paper` (or
        // fall back to MUI defaults internally) never show the stock
        // `#fff` / `#121212` fills — those are what made panels read as the
        // wrong colour against the app canvas in both schemes.
        background: {
          default: surfaces.light.level0,
          paper: surfaces.light.level1,
        },

        goldFg: "rgb(104, 48, 9)",
        goldBg: "rgba(255, 193, 7, 0.6)",
        shadow: ink(0.12),
        blue: accent.light.main,
        blueHover: "#1a7cd4ff",
        blueActive: "#166bbf",
        onBlue: text.dark.primary,

        ...surfaces.light,
      },
    },
    dark: {
      palette: {
        primary: { main: chalkSolid.base, light: "#E8E7E4" },
        secondary: { main: "#B0AEAA" },
        text: text.dark,
        divider: highlight(0.08),

        background: {
          default: surfaces.dark.level0,
          paper: surfaces.dark.level1,
        },

        goldFg: "#FFD700",
        goldBg: "rgba(255, 215, 0, 0.2)",
        shadow: darkInk(0.5),
        blue: accent.dark.main,
        blueHover: "#2787e6ff",
        blueActive: "#1f76cc",
        onBlue: text.dark.primary,

        ...surfaces.dark,
      },
    },
  },

  shape: { borderRadius: 14 },

  shadows: Array(25).fill("none") as unknown[] as Shadows,

  typography: {
    fontFamily: uiFont,
    pxToRem: (px: number) => `${px / 16}rem`,

    displayLarge: {
      fontSize: 57,
      lineHeight: 1.05,
      fontWeight: 500,
      letterSpacing: "-0.02em",
    },
    displayMedium: {
      fontSize: 45,
      lineHeight: 1.08,
      fontWeight: 500,
      letterSpacing: "-0.02em",
    },
    displaySmall: {
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
        // Browser-owned surfaces. Theme them from the palette so every drawing
        // plane shares the design instead of shipping platform defaults.
        "*": {
          caretColor: themeParam.vars.palette.text?.primary,
          fontVariantNumeric: "tabular-nums",
        },
        "::selection": {
          backgroundColor: `rgba(${accent.light.rgb}, 0.25)`,
          color: "inherit",
          ...themeParam.applyStyles("dark", {
            backgroundColor: `rgba(${accent.dark.rgb}, 0.35)`,
          }),
        },
        "*::-webkit-scrollbar": {
          width: 10,
          height: 10,
        },
        "*::-webkit-scrollbar-track": {
          background: "transparent",
        },
        "*::-webkit-scrollbar-thumb": {
          backgroundColor: ink(0.16),
          borderRadius: 6,
          border: "2px solid transparent",
          backgroundClip: "padding-box",
          ...themeParam.applyStyles("dark", {
            backgroundColor: highlight(0.16),
          }),
        },
        ":focus-visible": {
          outline: `2px solid rgba(${accent.light.rgb}, 0.7)`,
          outlineOffset: 2,
          ...themeParam.applyStyles("dark", {
            outline: `2px solid rgba(${accent.dark.rgb}, 0.75)`,
          }),
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
          boxShadow: premiumSurface.light.hover,
          border: hairline.light(),
          ...theme.applyStyles("dark", {
            boxShadow: premiumSurface.dark.hover,
            border: hairline.dark(),
          }),
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
          boxShadow: premiumSurface.light.rest,
          ...theme.applyStyles("dark", {
            boxShadow: premiumSurface.dark.rest,
          }),
        }),
      },
    },

    MuiSwitch: {
      styleOverrides: {
        root: {
          // Square switch (shadcn switch-2 look, adapted to MUI): small radii
          // on the thumb and track instead of the default pill geometry.
          // Applied globally so every <Switch> inherits the new look.
          "& .MuiSwitch-thumb": {
            borderRadius: 3,
          },
          "& .MuiSwitch-track": {
            borderRadius: 5,
          },
        },
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
          boxShadow: premiumSurface.light.rest,
          transition:
            "transform 150ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1)",
          "&:hover": {
            transform: "translateY(-1px)",
            boxShadow: premiumSurface.light.hover,
          },
          "&:active": {
            transform: "scale(0.98)",
            boxShadow: premiumSurface.light.active,
          },
          ...theme.applyStyles("dark", {
            boxShadow: premiumSurface.dark.rest,
            "&:hover": {
              transform: "translateY(-1px)",
              boxShadow: premiumSurface.dark.hover,
            },
            "&:active": {
              transform: "scale(0.98)",
              boxShadow: premiumSurface.dark.active,
            },
          }),
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
          boxShadow: premiumSurface.light.rest,
          ...theme.applyStyles("dark", {
            boxShadow: premiumSurface.dark.rest,
          }),
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
          border: hairline.light(),
          boxShadow: premiumSurface.light.hover,
          ...theme.applyStyles("dark", {
            border: hairline.dark(),
            boxShadow: premiumSurface.dark.hover,
          }),
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
            transform: "scale(0.97)",
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
        contained: ({ theme }) => ({
          color: surfaces.light.level1,
          backgroundColor: inkSolid.base,
          boxShadow: premiumSurface.light.rest,
          "&:hover": {
            backgroundColor: inkSolid.raised,
            boxShadow: premiumSurface.light.hover,
            transform: "translateY(-1px)",
          },
          "&:active": {
            transform: "scale(0.98) translateY(0)",
            boxShadow: premiumSurface.light.active,
            backgroundColor: inkSolid.pressed,
          },
          ...theme.applyStyles("dark", {
            color: surfaces.dark.level0,
            backgroundColor: chalkSolid.base,
            boxShadow: premiumSurface.dark.rest,
            "&:hover": {
              backgroundColor: chalkSolid.raised,
              boxShadow: premiumSurface.dark.hover,
              transform: "translateY(-1px)",
            },
            "&:active": {
              transform: "scale(0.98) translateY(0)",
              boxShadow: premiumSurface.dark.active,
              backgroundColor: chalkSolid.pressed,
            },
          }),
        }),
      },
      variants: [
        {
          props: { variant: "flat" },
          style: ({ theme }) => {
            return {
              backgroundColor: theme.vars.palette.level1,
              color: theme.vars.palette.primary.main,
              boxShadow: premiumSurface.light.rest,
              "&:hover": {
                backgroundColor: theme.vars.palette.level2,
                boxShadow: premiumSurface.light.hover,
                transform: "translateY(-1px)",
              },
              "&:active": {
                backgroundColor: theme.vars.palette.level3,
                transform: "scale(0.98) translateY(0)",
                boxShadow: premiumSurface.light.active,
              },
              ...theme.applyStyles("dark", {
                boxShadow: premiumSurface.dark.rest,
                "&:hover": {
                  backgroundColor: theme.vars.palette.level2,
                  boxShadow: premiumSurface.dark.hover,
                  transform: "translateY(-1px)",
                },
                "&:active": {
                  backgroundColor: theme.vars.palette.level3,
                  transform: "scale(0.98) translateY(0)",
                  boxShadow: premiumSurface.dark.active,
                },
              }),
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
              inset 0 1px 0 ${highlight(0.28)},
              inset 0 2px 0 ${highlight(0.1)},
              0 6px 16px rgba(${accent.light.rgb}, 0.35)
            `,
            ...theme.applyStyles("dark", {
              boxShadow: `
                inset 0 1px 0 ${highlight(0.28)},
                inset 0 2px 0 ${highlight(0.1)},
                0 6px 16px rgba(${accent.dark.rgb}, 0.35)
              `,
            }),
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
          border: hairline.light(0.08),
          ...theme.applyStyles("dark", {
            border: hairline.dark(0.08),
          }),
        }),
      },
      variants: [
        {
          props: { variant: "flat" },
          style: ({ theme }) => ({
            backgroundColor: theme.vars.palette.level1,
            boxShadow: premiumSurface.light.rest,
            border: hairline.light(0.04),
            transition:
              "transform 180ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1)",
            ...theme.applyStyles("dark", {
              boxShadow: premiumSurface.dark.rest,
              border: hairline.dark(0.04),
            }),
          }),
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
        root: ({ theme }) => ({
          backgroundColor: theme.vars.palette.level1,
          borderRadius: 16,
          border: hairline.light(0.05),
          boxShadow: premiumSurface.light.rest,
          transition:
            "transform 180ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1)",
          "&:hover": {
            transform: "translateY(-1px)",
            boxShadow: premiumSurface.light.hover,
          },
          ...theme.applyStyles("dark", {
            border: hairline.dark(0.05),
            boxShadow: premiumSurface.dark.rest,
            "&:hover": {
              transform: "translateY(-1px)",
              boxShadow: premiumSurface.dark.hover,
            },
          }),
        }),
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
        root: ({ theme }) => ({
          borderRadius: 14,
          marginBottom: 4,
          minHeight: 44,
          paddingTop: 10,
          paddingBottom: 10,
          transition:
            "transform 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 180ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms cubic-bezier(0.23, 1, 0.32, 1), color 180ms cubic-bezier(0.23, 1, 0.32, 1)",
          "&:hover": {
            backgroundColor: ink(0.04),
          },
          "&:active": {
            transform: "scale(0.985)",
          },
          "&.Mui-selected": {
            backgroundColor: inkSolid.base,
            color: surfaces.light.level1,
            boxShadow: premiumSurface.light.selected,
            "&:hover": {
              backgroundColor: inkSolid.raised,
            },
            "& .MuiListItemText-primary": {
              color: surfaces.light.level1,
              fontWeight: 650,
            },
            "& .MuiListItemText-secondary": {
              color: highlight(0.72),
            },
            "& .MuiSvgIcon-root": {
              color: surfaces.light.level1,
            },
          },
          ...theme.applyStyles("dark", {
            "&:hover": {
              backgroundColor: highlight(0.04),
            },
            "&.Mui-selected": {
              backgroundColor: surfaces.dark.level2,
              boxShadow: premiumSurface.dark.selected,
              "&:hover": {
                backgroundColor: surfaces.dark.level3,
              },
            },
          }),
        }),
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

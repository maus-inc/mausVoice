import type { SxProps, Theme } from "@mui/material";
import type { SystemStyleObject } from "@mui/system";
import { activeRowSx } from "../../styles/selection";
import { hairline, premiumSurface } from "../../styles/shadows";

/**
 * Vertical space reserved outside an open menu: the 40px title bar plus the
 * dialog margins and padding a picker usually opens inside. Keeping it in one
 * named constant stops the two paper variants from drifting apart.
 */
const MENU_VIEWPORT_INSET = 96;

/** Watermelon dropdown paper: hairline + rest lift, not hover-stage chrome. */
const chromeMenuPaperStyles = (theme: Theme): SystemStyleObject<Theme> => ({
  borderRadius: 1.5,
  py: 0.5,
  mt: 0.5,
  // Every chrome menu bounds itself and scrolls. Without a maxHeight the
  // language paper ran past the window's bottom edge and clipped mid-row;
  // the horizontal axis stays hidden so the rounded corners still clip the
  // content, and `auto` on the vertical axis gives the paper a themed
  // scrollbar only when it actually overflows.
  maxHeight: `min(400px, calc(100vh - ${MENU_VIEWPORT_INSET}px))`,
  overflowX: "hidden",
  overflowY: "auto",
  border: hairline.light(0.06),
  boxShadow: premiumSurface.light.rest,
  backgroundColor: "background.paper",
  ...theme.applyStyles("dark", {
    border: hairline.dark(0.05),
    boxShadow: premiumSurface.dark.rest,
  }),
});

export const chromeMenuPaperSx: SxProps<Theme> = chromeMenuPaperStyles;

export const chromeStyleSelectMenuPaperSx: SxProps<Theme> = (theme) => ({
  ...chromeMenuPaperStyles(theme),
  maxHeight: `min(360px, calc(100vh - ${MENU_VIEWPORT_INSET}px))`,
});

/**
 * Compact picker row: 14px type on a 4px rhythm lands in DESIGN.md's dense
 * 32-36px row band, matching the Attio/Linear-class pickers this chrome was
 * measured against. Symmetric radius, no stripes.
 */
export const chromeMenuItemSx = {
  borderRadius: 1,
  mx: 0.5,
  my: 0.25,
  py: 0.75,
  fontSize: "0.875rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 1,
} as const;

export const chromeSelectMenuItemSx = {
  ...chromeMenuItemSx,
  ...activeRowSx,
  "&.Mui-selected": {
    fontWeight: 600,
  },
} as const;

export const selectedOptionLabel = <Option>(
  value: string,
  options: readonly Option[],
  idOf: (option: Option) => string,
  labelOf: (option: Option) => string,
): string => {
  const match = options.find((option) => idOf(option) === value);
  return match ? labelOf(match) : "";
};

export const chromeSelectMenuProps = {
  slotProps: {
    paper: {
      sx: chromeMenuPaperSx,
    },
  },
} as const;

export const chromeStyleSelectMenuProps = {
  slotProps: {
    paper: {
      sx: chromeStyleSelectMenuPaperSx,
    },
  },
} as const;

export const chromeDialogPaperSx: SxProps<Theme> = {
  borderRadius: 2.5,
};

import type { SxProps, Theme } from "@mui/material";
import type { SystemStyleObject } from "@mui/system";
import { activeRowSx } from "../../styles/selection";
import { hairline, premiumSurface } from "../../styles/shadows";

/** Watermelon dropdown paper: hairline + rest lift, not hover-stage chrome. */
const chromeMenuPaperStyles = (theme: Theme): SystemStyleObject<Theme> => ({
  borderRadius: 1.5,
  py: 0.5,
  mt: 0.5,
  // Scrollable rather than clipped. `overflow: "hidden"` cut off any option
  // past the viewport's bottom, which the language menu and every long provider
  // list hit. The horizontal axis stays hidden so the rounded corners still
  // clip the content, and `auto` on the vertical axis is what gives the paper a
  // scrollbar only when it actually overflows.
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
  maxHeight: "min(360px, calc(100vh - 96px))",
});

export const chromeMenuItemSx = {
  borderRadius: 1,
  mx: 0.5,
  my: 0.25,
  py: 1,
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

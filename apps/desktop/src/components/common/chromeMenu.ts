import type { SxProps, Theme } from "@mui/material";
import { hairline, premiumSurface } from "../../styles/shadows";

/** Watermelon dropdown paper: hairline + rest lift, not hover-stage chrome. */
export const chromeMenuPaperSx: SxProps<Theme> = (theme) => ({
  borderRadius: 1.5,
  py: 0.5,
  mt: 0.5,
  overflow: "hidden",
  border: hairline.light(0.06),
  boxShadow: premiumSurface.light.rest,
  backgroundColor: "background.paper",
  ...theme.applyStyles("dark", {
    border: hairline.dark(0.05),
    boxShadow: premiumSurface.dark.rest,
  }),
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

export const chromeDialogPaperSx: SxProps<Theme> = {
  borderRadius: 2.5,
};

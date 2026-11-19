import type { SxProps, Theme } from "@mui/material/styles";

/**
 * Clips an element to a single pixel instead of hiding it with `display` or
 * `visibility`, the two properties a screen reader also skips. Content inside
 * stays in the accessibility tree and in a live region's announcement path
 * while carrying no layout weight and no visible trace, the standard
 * sighted-silent / assistive-tech-audible split (`SettingsLayout`'s search
 * result count and the tip toaster's new-tip announcement both use this).
 */
export const visuallyHidden: SxProps<Theme> = {
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

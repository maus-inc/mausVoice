import type { SxProps, Theme } from "@mui/material/styles";

/**
 * Clips an element to a single pixel instead of hiding it with `display` or
 * `visibility`, the two properties a screen reader also skips. Content inside
 * stays in the accessibility tree and in a live region's announcement path
 * while carrying no layout weight and no visible trace, the standard
 * sighted-silent / assistive-tech-audible split. Consumers include the tip
 * toaster's new-tip announcement, the settings search result count, and the
 * activity heatmap's headings and per-day list.
 *
 * The box is pinned to its containing block's origin on purpose. A clipped box
 * still occupies its static position, which is where the scrollbar bug came
 * from. Portalled to the body it landed at the end of the flow with its bottom
 * edge one pixel past the viewport, and inside a scrolled pane it landed past
 * the pane's own bottom while its containing block stayed the initial one, so
 * neither the pane nor the shell clipped it. One stray pixel is enough to make
 * the document scroll, and a scrollable document paints a second scrollbar
 * beside the pane's own.
 */
export const visuallyHidden: SxProps<Theme> = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

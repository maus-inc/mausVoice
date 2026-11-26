import { Box } from "@mui/material";

/**
 * The one element that owns the window box.
 *
 * `MuiCssBaseline` clips the document, so the window has exactly one scrolling
 * structure: this box, and then whatever panes each route opens inside it. It
 * takes the height the baseline's 100% chain already establishes rather than
 * `100dvh` and `100vw`, which are sized as if scrollbars do not exist. Once one
 * axis gains a scrollbar, a viewport-unit box is wider or taller than the space
 * left for it, which starts the second scrollbar, and the two keep each other
 * alive for as long as the window is open.
 */
export const AppViewport = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <Box sx={{ height: "100%", width: "100%", overflow: "hidden" }}>
    {children}
  </Box>
);

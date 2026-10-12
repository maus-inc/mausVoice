import { Box, Stack } from "@mui/material";
import { QuickShortcutsCard } from "../home/QuickShortcutsCard";
import { YourModelsCard } from "../home/YourModelsCard";

/**
 * The overview: the two things a person opens settings to check, as cards that
 * answer at a glance and hand the full page the moment they are clicked.
 *
 * Every row here is a summary of a row that lives on another page, and each one
 * resolves its target through the registry rather than by being told a path, so
 * nothing on this page carries an anchor of its own — see `SettingSummaryRow`.
 *
 * The cards sit in the middle of the surface rather than at the top of it. Two
 * cards of unequal height pinned to the top left the rest of the window empty,
 * and a page whose content occupies a third of its height reads as unfinished
 * no matter how good the third is. Centred, the same emptiness becomes the
 * margin around the answer instead of a space the answer failed to fill. The
 * page grows into the surface the layout hands it — see `minHeight` in
 * `SettingsLayout` — so this only ever centres space that is genuinely spare:
 * once the two cards are taller than the window, there is none left to move
 * them into and the centring does nothing.
 */
export default function HomeSettingsPage() {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        // Takes the surface's leftover height; without it the cards would sit
        // directly under the heading with the window's emptiness below them.
        flexGrow: 1,
        // The gap the cards would otherwise sit at the top of, halved: enough
        // that the pair never touches the heading above it on a short window.
        py: 2,
      }}
    >
      <Stack
        direction="row"
        sx={{
          // Two cards side by side when there is room for both to hold a row,
          // stacked when there is not. A media query would have to guess where
          // that line falls; the row's own minimum width is the line.
          flexWrap: "wrap",
          gap: 4,
          alignItems: "flex-start",
          "& > *": { flex: "1 1 340px", minWidth: 0 },
        }}
      >
        <Box>
          <QuickShortcutsCard />
        </Box>
        <Box>
          <YourModelsCard />
        </Box>
      </Stack>
    </Box>
  );
}

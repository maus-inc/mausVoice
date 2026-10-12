import { Stack } from "@mui/material";
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
 * The page holds no opinion about where it sits vertically. Its heading and its
 * cards travel together as one block, centred when there is room and otherwise
 * laid out from the top — see the `auto` margins in `SettingsLayout`. Centring
 * the cards here instead put the free space *between* the heading and the cards,
 * which is what made the page look like it had come apart.
 */
export default function HomeSettingsPage() {
  return (
    <Stack
      direction="row"
      sx={{
        // Two cards side by side when there is room for both to hold a row,
        // stacked when there is not. A media query would have to guess where
        // that line falls; the row's own minimum width is the line.
        flexWrap: "wrap",
        gap: 4,
        // Tops aligned, bottoms free. Two cards of different row counts end at
        // different heights, and stretching the shorter one to match would only
        // move the emptiness inside the card.
        alignItems: "flex-start",
        "& > *": { flex: "1 1 340px", minWidth: 0 },
      }}
    >
      <QuickShortcutsCard />
      <YourModelsCard />
    </Stack>
  );
}

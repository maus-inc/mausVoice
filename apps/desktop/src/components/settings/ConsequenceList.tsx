import { Box, Typography } from "@mui/material";
import type { ReactNode } from "react";

/**
 * What a destructive action will do, as a short scannable list.
 *
 * Both confirmation dialogs used to explain themselves in one long sentence,
 * which is the part of a destructive flow people skip: the consequences are the
 * reason the dialog exists. Each item gets its own line and the group gets a
 * label, so the list can be read in the order it matters without parsing prose.
 *
 * The tone is quiet on purpose. The colour and the surrounding surface already
 * say "destructive"; shouting it in every row would make the one line that is
 * about the person's data harder to find, not easier.
 */
export const ConsequenceList = ({
  label,
  items,
}: {
  /** Short heading: names what the action removes. */
  label: ReactNode;
  items: ReactNode[];
}) => (
  <Box
    sx={{
      border: 1,
      borderColor: "divider",
      // The dialog's inner card, matching the app's card radius. Anything
      // rounder than the dialog holding it reads as a mistake.
      borderRadius: 1,
      bgcolor: "level2",
      px: 2,
      py: 1.5,
    }}
  >
    <Typography
      variant="caption"
      component="h3"
      sx={{
        display: "block",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "text.secondary",
      }}
    >
      {label}
    </Typography>
    <Box
      component="ul"
      sx={{
        m: 0,
        mt: 1,
        p: 0,
        listStyle: "none",
        display: "grid",
        gap: 0.75,
      }}
    >
      {items.map((item, index) => (
        <Box
          // The list is a fixed set of sentences rather than data, so position
          // is a stable identity here.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          component="li"
          sx={{ display: "flex", gap: 1.25, alignItems: "flex-start" }}
        >
          <Box
            aria-hidden
            sx={{
              width: 5,
              height: 5,
              mt: "7px",
              borderRadius: "50%",
              bgcolor: "error.main",
              opacity: 0.75,
              flexShrink: 0,
            }}
          />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {item}
          </Typography>
        </Box>
      ))}
    </Box>
  </Box>
);

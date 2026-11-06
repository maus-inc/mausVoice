import { Box } from "@mui/material";
import type { ReactNode } from "react";

/**
 * The literal someone has to reproduce before a destructive action runs.
 *
 * Set apart from the instruction around it because as running text it read like
 * part of the sentence and was easy to mistype: monospace, its own surface, one
 * step down from the copy beside it. Both confirmation dialogs show the word
 * the same way through this, so a change to the treatment lands in both rather
 * than in whichever one was edited.
 */
export const ConfirmationPhrase = ({ children }: { children: ReactNode }) => (
  <Box
    component="code"
    sx={{
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      fontSize: "0.875em",
      px: 0.75,
      py: 0.25,
      // Half a step of the theme radius: the chip sits inside a sentence, so it
      // is rounder than the field below it without reading as a button.
      borderRadius: 0.5,
      border: 1,
      borderColor: "divider",
      bgcolor: "level2",
      // An address or a path is one long unbroken token, so it has to be able to
      // wrap inside the line it sits on.
      wordBreak: "break-all",
    }}
  >
    {children}
  </Box>
);

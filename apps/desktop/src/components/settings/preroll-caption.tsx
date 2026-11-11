import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

/**
 * What the pre-roll slider does at its current value.
 *
 * Two messages rather than one with a suffix: at zero the setting is genuinely
 * off, not small, and saying "keeps a little" would describe a window that does
 * not exist.
 */
export const PrerollCaption = ({ on }: { readonly on: boolean }) => (
  <Typography variant="caption" color="text.secondary">
    {on ? (
      <FormattedMessage defaultMessage="How much speech to keep from just before you press, so a word you start early is not cut off." />
    ) : (
      <FormattedMessage defaultMessage="Nothing is kept from before the press, so the first word is captured only once recording starts." />
    )}
  </Typography>
);

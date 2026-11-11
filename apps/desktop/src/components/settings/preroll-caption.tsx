import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

/**
 * What the pre-roll slider does at its current value.
 *
 * Two messages rather than one with a suffix: at zero the setting is genuinely
 * off, not small, and saying "keeps a little" would describe a window that does
 * not exist.
 *
 * Both messages name the condition the setting depends on: a stream has to
 * already be running. The old copy said only "keep from just before you press",
 * which reads as a promise about every press, and a cold press seeds its
 * recording from an empty buffer by construction. The setting therefore does
 * nothing for the default configuration, and saying so is the difference
 * between a slider that looks inert and one the user can make work.
 */
export const PrerollCaption = ({ on }: { readonly on: boolean }) => (
  <Typography variant="caption" color="text.secondary">
    {on ? (
      <FormattedMessage defaultMessage="How much speech to keep from just before you press, so a word you start early is not cut off. This needs the microphone to already be open: turn on keep-ready or a post-dictation window for it to apply." />
    ) : (
      <FormattedMessage defaultMessage="Nothing is kept from before the press, so the first word is captured only once recording starts." />
    )}
  </Typography>
);

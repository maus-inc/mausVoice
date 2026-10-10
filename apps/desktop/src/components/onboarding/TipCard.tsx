import {
  Eye,
  MessageSquareText,
  PenLine,
  Rocket,
  Sparkles,
  X,
} from "lucide-react";
import { Box, IconButton, Stack, Typography } from "@mui/material";
import type { SxProps } from "@mui/material/styles";
import type { SystemStyleObject, Theme } from "@mui/system";
import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useAppStore } from "../../store";
import type { OnboardingTipId } from "../../utils/tips";

export const TIP_COPY: Record<
  OnboardingTipId,
  { title: ReactNode; body: ReactNode; action: ReactNode }
> = {
  "generative-provider": {
    title: (
      <FormattedMessage defaultMessage="Add an AI provider for polishing" />
    ),
    body: (
      <FormattedMessage defaultMessage="Dictation works on its own, but styles and cleanup need a text-generation provider. Add one to unlock polishing, rewrites, and the assistant." />
    ),
    action: <FormattedMessage defaultMessage="Open settings" />,
  },
  "writing-styles": {
    title: <FormattedMessage defaultMessage="Teach mausVoice how you write" />,
    body: (
      <FormattedMessage defaultMessage="Styles reshape your dictation into your voice: emails, notes, code comments. Create one from a sample and it applies on every insert." />
    ),
    action: <FormattedMessage defaultMessage="Browse styles" />,
  },
  "assistant-mode": {
    title: <FormattedMessage defaultMessage="Talk to the assistant" />,
    body: (
      <FormattedMessage defaultMessage="Beyond dictation, the assistant answers questions, edits text, and runs tools in this chat. Anything you dictate can become a question." />
    ),
    action: <FormattedMessage defaultMessage="Open chat" />,
  },
  "review-before-insert": {
    title: <FormattedMessage defaultMessage="Review before it inserts" />,
    body: (
      <FormattedMessage defaultMessage="Review mode holds each transcript on the pill first, so you can edit or cancel before a word reaches your document." />
    ),
    action: <FormattedMessage defaultMessage="See history" />,
  },
  "update-channel": {
    title: <FormattedMessage defaultMessage="Try beta builds early" />,
    body: (
      <FormattedMessage defaultMessage="Stable ships tested releases. The beta channel offers prereleases early, and you can switch back at any time from settings." />
    ),
    action: <FormattedMessage defaultMessage="Open settings" />,
  },
};

/**
 * One bare glyph per tip, from the app's lucide set (stroke 1.9, the
 * sanctioned icon family), 16px, the app's standard quiet-glyph size.
 * `TipCardFrame` renders them at `text.secondary` with no tile behind them,
 * and `TipToastCard` reuses the same glyphs next to the same titles, so the
 * icon for a given tip never drifts between its toast and its Help row.
 */
export const TIP_ICONS: Record<OnboardingTipId, ReactNode> = {
  "generative-provider": <Sparkles size={16} strokeWidth={1.9} aria-hidden />,
  "writing-styles": <PenLine size={16} strokeWidth={1.9} aria-hidden />,
  "assistant-mode": (
    <MessageSquareText size={16} strokeWidth={1.9} aria-hidden />
  ),
  "review-before-insert": <Eye size={16} strokeWidth={1.9} aria-hidden />,
  "update-channel": <Rocket size={16} strokeWidth={1.9} aria-hidden />,
};

/**
 * Subscribes a component to a tip's visibility: true while the tip has not
 * been dismissed, false after `dismissTip` has persisted it.
 */
export const useTip = (id: OnboardingTipId): boolean =>
  useAppStore((s) => !(s.local.dismissedTipIds ?? []).includes(id));

/**
 * Flattens every `SxProps` form (object, array, theme function, or a mix)
 * into one style object for the given theme, so a caller's override (e.g.
 * the Help list's dismissed-tip dim) merges over the frame's base styles
 * instead of being dropped.
 */
const collectSx = (
  value: SxProps<Theme> | undefined,
  theme: Theme,
): SystemStyleObject<Theme> => {
  const out: Record<string, unknown> = {};
  const walk = (part: SxProps<Theme> | undefined): void => {
    if (!part) return;
    if (typeof part === "function") {
      walk(part(theme));
      return;
    }
    if (Array.isArray(part)) {
      part.forEach(walk);
      return;
    }
    Object.assign(out, part);
  };
  walk(value);
  return out as SystemStyleObject<Theme>;
};

/**
 * The presentational shell the Help list renders one of per tip. A
 * notification _row_, not a banner. A flat level1 face with a 1px hairline
 * and the standard card radius, the same material as a list row.
 *
 * Live tips surface as corner toasts (`TipToastCard`); this frame now serves
 * only `HelpPage`, which lists every tip (dismissed or not) with a "Show
 * again" action in place of a dismiss control. The copy and icons are
 * single-sourced in this file so a change to tip wording or iconography is
 * made once and both surfaces pick it up.
 */
export const TipCardFrame = ({
  title,
  body,
  icon,
  actions,
  onDismiss,
  sx,
}: {
  title: ReactNode;
  body: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  sx?: SxProps;
}) => {
  const intl = useIntl();
  return (
    <Box
      role="note"
      sx={(theme) => {
        // Overrides resolve here (theme in hand) so any `SxProps` form a
        // caller passes merges over the base instead of into a second entry.
        const overrides = collectSx(sx, theme);
        return {
          display: "flex",
          alignItems: "center",
          gap: 1,
          p: 2,
          pr: 1.5,
          borderRadius: 1,
          border: 1,
          borderColor: "divider",
          // Flat on purpose: in-flow, the row separates by its luminance step
          // (level1 over level0) and its hairline, no `premiumSurface` cast.
          bgcolor: "level1",
          ...overrides,
        };
      }}
    >
      {icon ? (
        <Box
          component="span"
          aria-hidden
          sx={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            color: "text.secondary",
          }}
        >
          {icon}
        </Box>
      ) : null}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="titleSmall"
          sx={{ letterSpacing: "-0.01em", maxWidth: "60ch" }}
        >
          {title}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.25, maxWidth: "60ch" }}
        >
          {body}
        </Typography>
      </Box>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ flexShrink: 0, alignItems: "center", ml: 1 }}
      >
        {actions}
        {onDismiss && (
          <IconButton
            size="small"
            onClick={onDismiss}
            aria-label={intl.formatMessage({ defaultMessage: "Dismiss tip" })}
            // No explicit glyph sizing: the theme sizes lucide glyphs inside
            // icon buttons to the app-wide 16px / 1.9 stroke.
            sx={{ color: "text.secondary", ml: 0.5 }}
          >
            <X aria-hidden />
          </IconButton>
        )}
      </Stack>
    </Box>
  );
};

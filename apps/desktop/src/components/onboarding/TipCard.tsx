import {
  Eye,
  MessageSquareText,
  PenLine,
  Rocket,
  Sparkles,
  X,
} from "lucide-react";
import { Box, Button, IconButton, Stack, Typography } from "@mui/material";
import type { SxProps } from "@mui/material/styles";
import type { SystemStyleObject, Theme } from "@mui/system";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { dismissTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { duration } from "../../styles/motion";
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
 * sanctioned icon family). 16px — the app's standard quiet-glyph size, the
 * same as the dismiss X it sits opposite. `TipCardFrame` renders them at
 * `text.secondary` with no tile behind them: a tip is a neutral nudge, and a
 * solid square backing would be a surface the message doesn't need.
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
 * The presentational shell both tip surfaces render: a notification _row_,
 * not a banner. A flat level1 face with a 1px hairline and the standard card
 * radius — the same material as a list row — so a tip reads as part of the
 * page, never as an ad pinned to it.
 *
 * Deliberately quiet (Linear's inbox rows are the reference class for this
 * component): a bare 16px glyph at `text.secondary` instead of an icon tile,
 * no drop shadow (elevation shadows stay with floating layers — toasts,
 * dialogs, popovers — per the "borders over shadows" rule), and the
 * affordances gathered on the right the way the app's toasts gather theirs.
 *
 * `HelpPage` lists the same tips with a "Show again" action in place of the
 * dismiss control, so the copy, icons, and frame are all single-sourced here
 * and a change to tip presentation is made in one place.
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
          // (level1 over level0) and its hairline — no `premiumSurface` cast.
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

/**
 * Motion for a live tip: a quiet reveal — opacity plus a 6px rise on a
 * 160ms ease-out, lifting out the same way on dismiss. No scale, no spring:
 * DESIGN.md reserves springs for shared-layout indicators and sets content
 * reveals at 120–180ms ease-out (Linear's rows appear and clear the same
 * restrained way). Reduced motion drops the rise and keeps the same clock.
 *
 * The store update waits for the exit to finish so the layout reflows behind
 * the card, not under it.
 */
const tipVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.16, ease: "easeOut" } },
  gone: {
    opacity: 0,
    y: -6,
    transition: { duration: duration.exit, ease: "easeOut" },
  },
};
const tipFadeVariants: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.16, ease: "easeOut" } },
  gone: {
    opacity: 0,
    transition: { duration: duration.exit, ease: "easeOut" },
  },
};

const TipCardMotion = ({ children }: { children: ReactNode }) => {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      variants={reduceMotion ? tipFadeVariants : tipVariants}
      initial="hidden"
      animate="shown"
      exit="gone"
    >
      {children}
    </motion.div>
  );
};

export type TipCardAction = {
  /**
   * The button's label. Required (rather than falling back to the tip's
   * Help-list wording): in-page actions say what they do on this page, which
   * is not the same thing as the Help list's navigate wording.
   */
  label: ReactNode;
  /** In-place action performed on this page (e.g. reveal and open the control the tip is about). */
  onAction: () => void;
};

/**
 * The live in-page tip, rendered at the top of a feature page. Shows only
 * while the tip is not dismissed, animates a short entrance, and on dismiss
 * animates out and persists the dismissal once the exit finishes (an
 * interrupted exit is persisted on unmount instead, so navigating away
 * mid-animation cannot resurrect the tip).
 *
 * `action` is optional because the tips anchored on their own feature page
 * (Styling, Transcriptions) introduce the page itself and have nothing to
 * do in place; the others may offer one quiet in-page action.
 */
export const TipCard = ({
  id,
  action,
}: {
  id: OnboardingTipId;
  /** In-page action; omit it when the feature the tip introduces is the page itself. */
  action?: TipCardAction;
}) => {
  const visible = useTip(id);
  const [closing, setClosing] = useState(false);
  const dismissedRef = useRef(false);

  // A dismiss is a deliberate choice, so it must survive the exit being
  // interrupted (the user navigating away mid-animation): without this the
  // store update would be lost and the tip would reappear on the next visit.
  // The ref guard keeps the exit-completion and unmount paths from both
  // firing (and keeps StrictMode's double cleanup from double-tracking).
  useEffect(() => {
    return () => {
      if (closing && !dismissedRef.current) {
        dismissedRef.current = true;
        dismissTip(id);
      }
    };
  }, [closing, id]);

  if (!visible) return null;
  const copy = TIP_COPY[id];

  const handleDismiss = () => {
    if (closing) return;
    setClosing(true);
  };

  return (
    <AnimatePresence
      onExitComplete={() => {
        // Persist once the card has actually left; unmount handles the
        // interrupted case.
        if (!dismissedRef.current) {
          dismissedRef.current = true;
          dismissTip(id);
        }
      }}
    >
      {closing ? null : (
        <TipCardMotion key={id}>
          <TipCardFrame
            icon={TIP_ICONS[id]}
            title={copy.title}
            body={copy.body}
            onDismiss={handleDismiss}
            actions={
              action ? (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={action.onAction}
                  // A quiet secondary action: no arrow, which would read as a
                  // marketing CTA in an otherwise neutral row.
                  sx={{ textTransform: "none", borderRadius: 999 }}
                >
                  {action.label}
                </Button>
              ) : undefined
            }
          />
        </TipCardMotion>
      )}
    </AnimatePresence>
  );
};

import {
  ArrowRight,
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
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { dismissTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import {
  enterTransition,
  exitTransition,
  fadeVariants,
  riseVariants,
} from "../../styles/motion";
import { premiumSurface } from "../../styles/shadows";
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
 * One glyph per tip, from the app's lucide set (stroke 1.9, the sanctioned
 * icon family). The tile the glyph sits in is drawn by `TipCardFrame`, so the
 * icon and its backing never drift apart.
 */
export const TIP_ICONS: Record<OnboardingTipId, ReactNode> = {
  "generative-provider": <Sparkles size={18} strokeWidth={1.9} aria-hidden />,
  "writing-styles": <PenLine size={18} strokeWidth={1.9} aria-hidden />,
  "assistant-mode": (
    <MessageSquareText size={18} strokeWidth={1.9} aria-hidden />
  ),
  "review-before-insert": <Eye size={18} strokeWidth={1.9} aria-hidden />,
  "update-channel": <Rocket size={18} strokeWidth={1.9} aria-hidden />,
};

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
 * The presentational shell both tip surfaces render. A machined card from the
 * shared surface language (level1 face, divider hairline, `premiumSurface`
 * lift — the same treatment as dialogs and popovers) laid out as a
 * notification row: an icon tile the user reads first, the copy in the
 * middle, and the affordances (action, dismiss) gathered on the right, the
 * way the app's toasts gather theirs.
 *
 * `HelpPage` lists the same tips with a "Show again" action in place of the
 * dismiss control, so the copy, icons, and frame are all single-sourced here
 * and a change to tip presentation is made in one place.
 *
 * `dismissed` is carried as a prop rather than read from the store here, so
 * the same shell serves a live tip and a dismissed one.
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
          gap: 1.5,
          p: 2,
          pr: 1.5,
          borderRadius: 1,
          border: 1,
          borderColor: "divider",
          bgcolor: "level1",
          boxShadow: premiumSurface.light.rest,
          ...theme.applyStyles("dark", {
            boxShadow: premiumSurface.dark.rest,
          }),
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
            justifyContent: "center",
            flexShrink: 0,
            width: 34,
            height: 34,
            // 8px is the codebase's small-chip tier (the sonner action chip),
            // keeping the tile on a sanctioned radius instead of inventing one.
            borderRadius: 8,
            bgcolor: "level2",
            color: "text.primary",
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
        sx={{ flexShrink: 0, alignItems: "center" }}
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
 * Entrance/exit motion for a live tip: rises in with the shared product-chrome
 * spring and lifts out on dismiss (opacity-only when the user prefers reduced
 * motion, mirroring `AnimateIn`). The store update waits for the exit to
 * finish so the layout reflows behind the card, not under it.
 */
const TipCardMotion = ({ children }: { children: ReactNode }) => {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      variants={reduceMotion ? fadeVariants : riseVariants}
      initial="hidden"
      animate="shown"
      exit="gone"
      transition={reduceMotion ? exitTransition : enterTransition}
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
  /** In-place action (scroll + focus a control on this page). */
  onAction: () => void;
};

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
    if (!closing) return;
    return () => {
      if (!dismissedRef.current) {
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
                  endIcon={<ArrowRight size={14} strokeWidth={2} aria-hidden />}
                  onClick={action.onAction}
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

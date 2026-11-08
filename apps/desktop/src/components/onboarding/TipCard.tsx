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
import {
  cssEase,
  duration,
  easeOutQuint,
  pressScale,
} from "../../styles/motion";
import { surfaceAlpha, surfaces } from "../../styles/palette";
import { hairline, premiumSurface } from "../../styles/shadows";
import type { OnboardingTipId } from "../../utils/tips";
import tipToastPattern from "../../assets/tip-toast-pattern.png";
import { getTipAction } from "./tip-actions";

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
 * The in-page action for each live tip that has one, and its label. The
 * handler lives on the tip's route page (`tip-actions` registry), because it
 * mutates that page's own state (Settings' Groq dialog). Live tips without
 * an entry here introduce the page itself and carry no action.
 */
export const TIP_LIVE_ACTIONS: Partial<
  Record<OnboardingTipId, { label: ReactNode }>
> = {
  "generative-provider": {
    label: <FormattedMessage defaultMessage="Add API key" />,
  },
};

/**
 * Shared header art for every live tip. One abstract monochrome ink
 * pattern, evoking a voice waveform caught mid-motion, generated from the
 * app's own ink/onyx/silver tokens (`palette.ts`) rather than a stock photo.
 * One asset reused across all five tips, so the card's job is tone and brand
 * recognition, the same way a consistent header motif works across
 * unrelated posts on a changelog or careers page; the icon, title, and body
 * below still carry the tip's actual meaning.
 */
const PATTERN_HEIGHT = 96;

/**
 * The image fades into the card's own paper surface instead of ending on a
 * hard edge, so the art reads as part of the card rather than a clipped
 * photo pasted on top of it. Built from `surfaceAlpha` against the same hex
 * `background.paper` resolves to (`surfaces.*.level1`, see `theme.ts`), so
 * the translucent top of the gradient and the opaque body below it can
 * never drift apart.
 */
const patternFade = (tier: string) =>
  `linear-gradient(to top, ${surfaceAlpha(tier, 1)} 0%, ${surfaceAlpha(tier, 0)} 65%)`;

/**
 * One dark-scrim recipe over the shared pattern image, for the dismiss
 * control that sits on top of it. A literal colour, not a palette token:
 * `DESIGN.md` reserves that exception for artwork with its own fixed
 * luminance, and that is exactly the case here. The pattern image is the
 * same dark ink bitmap in both colour schemes, so a control sitting on top
 * of it needs the one contrast pairing that already reads against that
 * fixed artwork, not a light-mode and a dark-mode token pair.
 */
const SCRIM_INK = "20, 18, 15";
const scrimGlyph = "#F2F1EE";
const dismissScrim = {
  rest: `rgba(${SCRIM_INK}, 0.45)`,
  hover: `rgba(${SCRIM_INK}, 0.6)`,
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
 * not a banner. The base face is a flat level1 row with a 1px hairline and
 * the standard card radius — the material of an in-flow list row, which is
 * how `HelpPage` lists the tips. `TipCard` overrides the face to the
 * floating-layer material (paper + premium lift), because the live tips
 * float over the page.
 *
 * Deliberately quiet (Linear's inbox rows are the reference class for this
 * component): a bare 16px glyph at `text.secondary` instead of an icon tile,
 * the affordances gathered on the right the way the app's toasts gather
 * theirs, and no drop shadow in-flow (elevation is for floating layers).
 *
 * `HelpPage` lists the same tips with a "Show again" action in place of the
 * dismiss control, so the copy, icons, and frame are all single-sourced here
 * and a change to tip presentation is made in one place.
 */
export const TipCardFrame = ({
  title,
  body,
  icon,
  headingLevel,
  actions,
  onActivate,
  sx,
}: {
  title: ReactNode;
  body: ReactNode;
  icon?: ReactNode;
  headingLevel?: "h2" | "h3";
  actions?: ReactNode;
  /**
   * Marks this tip read when the title-and-body region itself is clicked
   * or activated from the keyboard, the fallback a tip with no live action
   * needs so reading it is enough to clear it, not just the 24px dismiss
   * glyph on the pattern image above. A tip with a live action leaves this
   * unset: its one explicit button already runs that action without also
   * closing the card, and the row would otherwise have to guess which of
   * two different effects a bare click on it should trigger.
   */
  onActivate?: () => void;
  sx?: SxProps;
}) => {
  const interactive = Boolean(onActivate);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!onActivate) return;
    // Ignore keys bubbling up from a focusable child (the live-action
    // button, when `actions` renders one) so this row's own Enter/Space
    // handling never fires alongside that child's native activation.
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate();
  };
  return (
    <Box
      data-tip-frame="true"
      role={interactive ? "button" : "note"}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
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
          ...(interactive && {
            cursor: "pointer",
            // Same wash-and-press recipe `TranscriptRow`'s clickable row
            // already uses, so an activatable tip row reads as one more
            // instance of a pattern the app already has, not a new one.
            transition: `background-color ${duration.fast * 1000}ms ${cssEase(easeOutQuint)}, transform 120ms ${cssEase(easeOutQuint)}`,
            "&:hover": { bgcolor: "action.hover" },
            "&:active": { transform: `scale(${pressScale})` },
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
          component={headingLevel ?? "p"}
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
      {actions && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ flexShrink: 0, alignItems: "center", ml: 1 }}
          // A live action's own button already runs its own effect on
          // click. Stopping the row's click here keeps that one effect
          // from also re-firing as this row's activation, the same
          // single-effect-per-click guarantee `onActivate` depends on.
          onClick={(event) => event.stopPropagation()}
        >
          {actions}
        </Stack>
      )}
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
      layout
      variants={reduceMotion ? tipFadeVariants : tipVariants}
      initial="hidden"
      animate="shown"
      exit="gone"
    >
      {children}
    </motion.div>
  );
};

/**
 * The live tip, rendered by `TipToaster` in the floating bottom-right stack
 * on the tip's own route. Shows only while the tip is not dismissed, animates
 * a short entrance, and on dismiss animates out and persists the dismissal
 * once the exit finishes (an interrupted exit is persisted on unmount instead,
 * so navigating away mid-animation cannot resurrect the tip).
 *
 * The face is the floating-layer material: paper over the page with the
 * premium lift the app reserves for things that float (toasts, dialogs,
 * popovers), at the toast column width so the two stacks align in the corner.
 * A pattern-image header sits on top of that face, the one visual flourish
 * a live tip gets that the Help page's flat listing (`TipCardFrame`) does
 * not; the dismiss control moves onto that image, in a scrim chip, so the
 * row below stays as quiet as the Help listing's.
 *
 * The in-page action, where one exists (`TIP_LIVE_ACTIONS`), runs the handler
 * the tip's route page registered in `tip-actions`. It never dismisses the
 * tip; the action completes the task, and dismissal stays the X's job.
 *
 * A tip with no live action instead makes its own title-and-body row the
 * activation target, through `onActivate` on `TipCardFrame`, so reading it
 * is enough to clear it. The dismiss glyph still works the same way in
 * both cases; it is just no longer the only way to mark a plain tip read.
 */
export const TipCard = ({ id }: { id: OnboardingTipId }) => {
  const intl = useIntl();
  const visible = useTip(id);
  const [closing, setClosing] = useState(false);
  const dismissedRef = useRef(false);
  const liveAction = TIP_LIVE_ACTIONS[id];

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
          <Box
            data-tip-card="true"
            sx={(cardTheme) => ({
              position: "relative",
              width: 356,
              overflow: "hidden",
              borderRadius: `${cardTheme.shape.borderRadius}px`,
              border: hairline.light(),
              boxShadow: premiumSurface.light.hover,
              bgcolor: "background.paper",
              ...cardTheme.applyStyles("dark", {
                border: hairline.dark(),
                boxShadow: premiumSurface.dark.hover,
              }),
            })}
          >
            <Box sx={{ position: "relative", height: PATTERN_HEIGHT }}>
              <Box
                component="img"
                src={tipToastPattern}
                alt=""
                aria-hidden
                sx={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
              <Box
                aria-hidden
                sx={(fadeTheme) => ({
                  position: "absolute",
                  inset: 0,
                  background: patternFade(surfaces.light.level1),
                  ...fadeTheme.applyStyles("dark", {
                    background: patternFade(surfaces.dark.level1),
                  }),
                })}
              />
              <IconButton
                size="small"
                onClick={handleDismiss}
                aria-label={intl.formatMessage({
                  defaultMessage: "Dismiss tip",
                })}
                sx={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  width: 24,
                  height: 24,
                  bgcolor: dismissScrim.rest,
                  color: scrimGlyph,
                  "&:hover": { bgcolor: dismissScrim.hover },
                }}
              >
                <X size={14} strokeWidth={1.9} />
              </IconButton>
            </Box>
            <TipCardFrame
              icon={TIP_ICONS[id]}
              title={copy.title}
              body={copy.body}
              // Only an actionless tip gets a click-to-dismiss row: a tip
              // with a live action keeps that one button as its only
              // effect, so the row never has to pick between running the
              // action and marking the tip read on the same click.
              onActivate={liveAction ? undefined : handleDismiss}
              actions={
                liveAction ? (
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => getTipAction(id)?.()}
                    // A quiet secondary action: no arrow, which would read
                    // as a marketing CTA in an otherwise neutral row.
                    sx={{ textTransform: "none", borderRadius: 999 }}
                  >
                    {liveAction.label}
                  </Button>
                ) : undefined
              }
              sx={{
                border: 0,
                borderRadius: 0,
                boxShadow: "none",
                bgcolor: "transparent",
              }}
            />
          </Box>
        </TipCardMotion>
      )}
    </AnimatePresence>
  );
};

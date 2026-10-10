import { X } from "lucide-react";
import { Box, IconButton, Typography } from "@mui/material";
import { useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { toast } from "sonner";
import { dismissTip } from "../../actions/onboarding.actions";
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
import { TIP_COPY, TIP_ICONS } from "./TipCard";

/**
 * Shared header art for every tip toast. One abstract monochrome ink
 * pattern, evoking a voice waveform caught mid-motion, generated from the
 * app's own ink/onyx/silver tokens (`palette.ts`) rather than a stock photo.
 * One asset reused across all five tips, so the card's job is tone and brand
 * recognition, the same way a consistent header motif works across unrelated
 * posts on a changelog or careers page; the icon, title, and body directly
 * below still carry the tip's actual meaning.
 */
const PATTERN_HEIGHT = 96;

/**
 * The image fades into the card's own body surface instead of ending on a
 * hard edge, so the art reads as part of the card rather than a clipped
 * photo pasted on top of it. Built from `surfaceAlpha` against the same hex
 * as the opaque `level1` tier, so the translucent top of the gradient and
 * the opaque body below it can never drift apart.
 */
const patternFade = (tier: string) =>
  `linear-gradient(to top, ${surfaceAlpha(tier, 1)} 0%, ${surfaceAlpha(tier, 0)} 65%)`;

/**
 * The toast surface itself. `level1` plus a hairline plus `premiumSurface`,
 * the same recipe `MuiDialog` and `MuiPopover` already use in `theme.ts`, and
 * the one `SonnerToaster.tsx` already applies to every other toast. A
 * floating layer is exactly the surface class DESIGN.md sanctions for this
 * border-and-shadow combination; the in-page tip rows stay flat for the
 * opposite reason.
 */
const cardSx = {
  position: "relative" as const,
  width: "100%",
  overflow: "hidden",
  border: hairline.light(),
  boxShadow: premiumSurface.light.hover,
  bgcolor: "level1",
};

/**
 * One dark-scrim recipe over the shared pattern image. The toast's own
 * dismiss button below and the Help list's thumbnail badge (`HelpPage.tsx`)
 * both sit on that same art, so the "ink chip on top of the pattern" look
 * is defined once here rather than as two copies of the same rgba string
 * that could quietly drift apart.
 *
 * These are literal colours, not palette tokens. `DESIGN.md` reserves that
 * exception for artwork with its own fixed luminance, and that is exactly
 * the case here. The pattern image is the same dark ink bitmap in both
 * colour schemes (only the fade at its lower edge, built from
 * `surfaceAlpha` below, switches with the card's own surface), so a badge
 * sitting on top of it needs the one contrast pairing that already reads
 * against that fixed artwork, not a light-mode and a dark-mode token pair.
 */
const SCRIM_INK = "20, 18, 15";
export const scrimGlyph = "#F2F1EE";
export const dismissScrim = {
  rest: `rgba(${SCRIM_INK}, 0.45)`,
  hover: `rgba(${SCRIM_INK}, 0.6)`,
};
export const thumbnailScrim = `rgba(${SCRIM_INK}, 0.38)`;

export type TipToastProps = {
  id: OnboardingTipId;
  /** In-place action performed when the body is activated, if this tip has one. */
  onAction?: () => void;
  /** Removes the toast itself; supplied by the sonner glue so this component never imports sonner. */
  onDismiss: () => void;
};

/**
 * The presentational and interactive card rendered inside the toast. Kept
 * free of any sonner import so it can be rendered and tested directly,
 * the same way `TipCardFrame` is testable without its live wrapper.
 *
 * The image strip and its dismiss control are one region; the icon, title,
 * and body are a second, separately activatable region. Nesting the
 * dismiss button inside the same clickable area as the body would make a
 * screen reader announce "Dismiss tip" as part of the body's own accessible
 * name, so the two stay siblings instead of one wrapping the other.
 */
export const TipToastCard = ({ id, onAction, onDismiss }: TipToastProps) => {
  const intl = useIntl();
  const copy = TIP_COPY[id];
  const icon = TIP_ICONS[id];
  // A dismiss is a deliberate choice, persisted the instant it happens,
  // not deferred to an animation completing. That sidesteps the whole class
  // of "interrupted exit" races the old in-page `TipCard` had to guard
  // against: there is nothing to interrupt when the write already landed.
  const firedRef = useRef(false);

  const handleDismiss = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation();
    if (firedRef.current) return;
    firedRef.current = true;
    dismissTip(id);
    onDismiss();
  };

  const handleActivate = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    onAction?.();
    dismissTip(id);
    onDismiss();
  };

  const handleBodyKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleActivate();
  };

  const handleDismissKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleDismiss(event);
  };

  return (
    <Box
      data-tip-toast="true"
      sx={(theme) => ({
        ...cardSx,
        borderRadius: `${theme.shape.borderRadius}px`,
        ...theme.applyStyles("dark", {
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
          sx={(theme) => ({
            position: "absolute",
            inset: 0,
            background: patternFade(surfaces.light.level1),
            ...theme.applyStyles("dark", {
              background: patternFade(surfaces.dark.level1),
            }),
          })}
        />
        <IconButton
          size="small"
          onClick={handleDismiss}
          onKeyDown={handleDismissKeyDown}
          aria-label={intl.formatMessage({ defaultMessage: "Dismiss tip" })}
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
      <Box
        role="button"
        tabIndex={0}
        onClick={handleActivate}
        onKeyDown={handleBodyKeyDown}
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1,
          p: 2,
          cursor: "pointer",
          // Default, hover, and active/press feedback: `:focus-visible` is
          // already covered by the global chrome-tinted ring in `theme.ts`.
          // The same wash and scale `TranscriptRow`'s clickable row and
          // `MuiIconButton` already use, not a one-off invented here.
          transition: `background-color ${duration.fast * 1000}ms ${cssEase(easeOutQuint)}, transform 120ms ${cssEase(easeOutQuint)}`,
          "&:hover": { bgcolor: "action.hover" },
          "&:active": { transform: `scale(${pressScale})` },
        }}
      >
        <Box
          component="span"
          aria-hidden
          sx={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            color: "text.secondary",
            mt: "2px",
          }}
        >
          {icon}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          {/* The row version (`TipCardFrame`) wraps this same title and body
              in full rather than truncating them, and every tip's copy is
              already written to this card's width. Wrapping, not `noWrap`,
              keeps that promise here. A tip's guidance is never cut short by
              an ellipsis, and the toast simply grows to fit it. */}
          <Typography variant="titleSmall" sx={{ letterSpacing: "-0.01em" }}>
            {copy.title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {copy.body}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};

/**
 * Shows (or replaces) the corner toast for a tip. Built on sonner's own
 * `toast.custom`, so a tip toast inherits the exact slide/fade motion,
 * stacking, and bottom-right position every other toast in the app already
 * uses, documented in `DESIGN.md` under Toasts.
 *
 * `duration: Infinity` keeps it on screen until the user acts. A feature
 * nudge that auto-expires before it's read defeats its own purpose.
 * Passing the tip id as sonner's id makes repeated calls (StrictMode, a
 * remount) replace the existing toast instead of stacking a duplicate.
 *
 * `dismissible: false` turns off sonner's own pointer-driven swipe-to-dismiss
 * gesture, the one removal path this card does not render its own control
 * for. Left on, a swipe would delete the toast without ever calling
 * `dismissTip`, so the tip would read as gone but reappear on the next visit.
 * Sonner's built-in close button is not in play here either way. It only
 * renders for its own styled toasts, never for a `toast.jsx` custom one like
 * this card, so there is exactly one removal path, this card's own click and
 * keyboard handlers, which is the one path that calls `dismissTip`.
 */
export const showTipToast = (
  id: OnboardingTipId,
  onAction?: () => void,
): void => {
  toast.custom(
    (toastId) => (
      <TipToastCard
        id={id}
        onAction={onAction}
        onDismiss={() => toast.dismiss(toastId)}
      />
    ),
    { id, duration: Number.POSITIVE_INFINITY, dismissible: false },
  );
};

/** Removes the toast without persisting a dismissal. Used when the owning page unmounts. */
export const hideTipToast = (id: OnboardingTipId): void => {
  toast.dismiss(id);
};

/**
 * Mounts a tip toast for exactly as long as the owning page is on screen,
 * matching the lifecycle the in-page `TipCard` had. The tip shows while its
 * page is mounted and is not dismissed, and clears (without being marked
 * dismissed) the moment the page unmounts, so leaving the page is not the
 * same thing as deciding you don't need the tip.
 *
 * Renders nothing itself; the toast lives in sonner's own layer.
 */
export const TipToastTrigger = ({
  id,
  visible,
  onAction,
}: {
  id: OnboardingTipId;
  /** Whether the tip has not been dismissed yet; pass the result of `useTip(id)`. */
  visible: boolean;
  onAction?: () => void;
}): null => {
  // The effect below only needs the latest callback when it actually shows
  // the toast; it must not re-run (and so re-show the toast) just because
  // the caller passed a new closure identity on every render.
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  useEffect(() => {
    if (!visible) return;
    showTipToast(id, () => onActionRef.current?.());
    return () => hideTipToast(id);
  }, [id, visible]);

  return null;
};

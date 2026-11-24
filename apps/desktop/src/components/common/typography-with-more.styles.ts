import type { Theme } from "@mui/material/styles";
import type { TypographyProps } from "@mui/material/Typography";
import { noHoverQuery } from "../../styles/motion";

const coarseTouchQuery = "(hover: none) and (pointer: coarse)";
const narrowInlineToggleQuery =
  "@container typography-with-more (max-width: 480px)";

export const defaultClampStyles = (maxLines: number) => ({
  display: "-webkit-box",
  WebkitLineClamp: maxLines,
  WebkitBoxOrient: "vertical" as const,
  overflow: "hidden",
});

/** The clamp only applies while the text is collapsed. */
const normalizeSxProp = (
  baseClampStyles: Record<string, unknown>,
  shouldClamp: boolean,
  sx: TypographyProps["sx"],
): TypographyProps["sx"] => (shouldClamp ? { ...baseClampStyles, ...sx } : sx);

type CssSpacing = number | string;

/** Padding that keeps the clamped text clear of the inline toggle. */
const clampPaddingAdjustments = (
  clampPaddingRight: CssSpacing | undefined,
  inlineToggleRight: CssSpacing | undefined,
) => [
  { pr: clampPaddingRight ?? 6 },
  ...(inlineToggleRight === undefined
    ? []
    : [{ [narrowInlineToggleQuery]: { pr: 0 } }]),
];

export const resolveTypographySx = ({
  clampStyles,
  shouldClamp,
  sx,
  clampPaddingRight,
  inlineToggleRight,
}: {
  clampStyles: Record<string, unknown>;
  shouldClamp: boolean;
  sx: TypographyProps["sx"];
  clampPaddingRight: number | string | undefined;
  inlineToggleRight: number | string | undefined;
}) => {
  const normalized = normalizeSxProp(clampStyles, shouldClamp, sx);
  if (!shouldClamp) return normalized;

  const paddingAdjustments = clampPaddingAdjustments(
    clampPaddingRight,
    inlineToggleRight,
  );
  if (Array.isArray(normalized)) return [...normalized, ...paddingAdjustments];
  if (normalized) return [normalized, ...paddingAdjustments];
  return paddingAdjustments;
};

/**
 * The hidden measuring node mirrors the visible text's inset without clamping,
 * so its scroll height is the full, unclamped height.
 */
export const resolveHiddenTypographySx = (
  clampPaddingRight: number | string | undefined,
  inlineToggleRight: number | string | undefined,
  sx: TypographyProps["sx"],
) => {
  const baseDisplay = { display: "block" } as const;
  if (
    clampPaddingRight === undefined &&
    inlineToggleRight === undefined &&
    !sx
  ) {
    return baseDisplay;
  }

  const styles = Array.isArray(sx) ? [...sx] : [];
  if (sx && !Array.isArray(sx)) {
    styles.push(sx);
  }
  if (clampPaddingRight !== undefined) {
    styles.push({ pr: clampPaddingRight });
  }
  if (inlineToggleRight !== undefined) {
    styles.push({ [narrowInlineToggleQuery]: { pr: 0 } });
  }

  return [baseDisplay, ...styles];
};

export type ToggleStyleOptions = {
  inline: boolean;
  fontSize: number | string | undefined;
  lineHeight: number | string | undefined;
  inlineToggleRight: number | string | undefined;
  variant: TypographyProps["variant"];
};

type ToggleMetrics = {
  fontSize: number | string;
  lineHeight: number | string;
  textPrimary: string;
  textSecondary: string;
};

const resolveToggleMetrics = (
  theme: Theme,
  options: ToggleStyleOptions,
): ToggleMetrics => {
  const variantKey = options.variant ?? "body2";
  const variantStyles =
    (theme.typography as Record<string, any>)[variantKey] ??
    theme.typography.body2;
  return {
    fontSize: options.fontSize ?? variantStyles.fontSize,
    lineHeight: options.lineHeight ?? variantStyles.lineHeight ?? 1.35,
    textPrimary: theme.vars?.palette.text.primary ?? theme.palette.text.primary,
    textSecondary:
      theme.vars?.palette.text.secondary ?? theme.palette.text.secondary,
  };
};

/**
 * The revealed state for the inline control, and for the out-of-flow chip.
 * Declared once each and reused by hover, keyboard focus and touch states so
 * their interaction affordances cannot drift apart.
 */
const inlineRevealStyles = (theme: Theme, textPrimary: string) => ({
  color: textPrimary,
  textDecorationColor: "currentColor",
  backgroundColor: theme.vars?.palette.level0 ?? theme.palette.background.paper,
});

const chipRevealStyles = (theme: Theme, textPrimary: string) => ({
  color: textPrimary,
  backgroundColor: theme.vars?.palette.level2 ?? theme.palette.action.hover,
});

const inlineToggleStyles = (
  theme: Theme,
  textPrimary: string,
  inlineToggleRight: number | string | undefined,
) => {
  const inlineReveal = inlineRevealStyles(theme, textPrimary);
  return {
    position: "absolute" as const,
    right: inlineToggleRight ?? 0,
    bottom: inlineToggleRight === undefined ? 0 : theme.spacing(1),
    mt: 0,
    py: 0,
    borderRadius: 999,
    // This background doubles as the truncation fade. Keep it painted on
    // reveal (a repaint would double-tone the mask) and signal interactivity
    // with color + underline instead, the link affordance for in-flow text.
    backgroundColor:
      theme.vars?.palette.level0 ?? theme.palette.background.paper,
    boxShadow: `-12px 0 12px ${
      theme.vars?.palette.level0 ?? theme.palette.background.paper
    }`,
    "&:hover": inlineReveal,
    "&:focus-visible": inlineReveal,
    // Touch devices have no hover state; the resting underline keeps the
    // inline disclosure recognizable. A no-pointer environment can still
    // reveal it on keyboard focus.
    [`@media ${coarseTouchQuery}`]: inlineReveal,
    ...(inlineToggleRight === undefined
      ? {}
      : {
          [narrowInlineToggleQuery]: {
            position: "static",
            right: "auto",
            bottom: "auto",
            display: "block",
            width: "fit-content",
            ml: "auto",
            mt: 0,
            backgroundColor: "transparent",
            boxShadow: "none",
            borderRadius: 0,
          },
        }),
  };
};

/** Ghost chip for the out-of-flow toggle, on the surface ladder's hover tier. */
const chipToggleStyles = (theme: Theme, textPrimary: string) => {
  const chipReveal = chipRevealStyles(theme, textPrimary);
  return {
    mt: 0.5,
    display: "block",
    ml: "auto",
    px: 1,
    py: 0.25,
    borderRadius: 0.75,
    "&:hover": chipReveal,
    "&:focus-visible": chipReveal,
    // Same reasoning as the inline variant: the chip's surface tier is its
    // affordance, and a touch device never hovers.
    [`@media ${noHoverQuery}`]: chipReveal,
    "&:active": {
      backgroundColor:
        theme.vars?.palette.level3 ?? theme.palette.action.selected,
    },
  };
};

/**
 * De-emphasized at rest so the disclosure control never competes with the
 * content. The inline form is a link and the block form is a quiet chip.
 */
export const toggleButtonSx =
  (options: ToggleStyleOptions) => (theme: Theme) => {
    const metrics = resolveToggleMetrics(theme, options);
    return {
      px: 0,
      minWidth: 0,
      fontSize: metrics.fontSize,
      lineHeight: metrics.lineHeight,
      textTransform: "none",
      fontWeight: theme.typography.fontWeightMedium,
      color: metrics.textSecondary,
      textDecoration: "underline",
      textDecorationColor: "transparent",
      textUnderlineOffset: 3,
      transition: `color 150ms ${theme.transitions.easing.easeOut}, background-color 150ms ${theme.transitions.easing.easeOut}, text-decoration-color 150ms ${theme.transitions.easing.easeOut}, transform 120ms ${theme.transitions.easing.easeOut}`,
      ...(options.inline
        ? inlineToggleStyles(
            theme,
            metrics.textPrimary,
            options.inlineToggleRight,
          )
        : chipToggleStyles(theme, metrics.textPrimary)),
    };
  };

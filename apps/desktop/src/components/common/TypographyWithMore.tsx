import { Box, Button, Typography, type TypographyProps } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { noHoverQuery } from "../../styles/motion";

const defaultClampStyles = (maxLines: number) => ({
  display: "-webkit-box",
  WebkitLineClamp: maxLines,
  WebkitBoxOrient: "vertical" as const,
  overflow: "hidden",
});

/** Preserve the caller's ordered MUI styles between the clamp and toggle space. */
const clampedSx = (
  baseClampStyles: Record<string, unknown>,
  sx: TypographyProps["sx"],
): TypographyProps["sx"] => [
  baseClampStyles,
  ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
  { pr: 6 },
];

/** Surface and text colors for both CSS-variable and ordinary MUI themes. */
const disclosurePalette = (theme: Theme) => ({
  primary: theme.vars?.palette.text.primary ?? theme.palette.text.primary,
  secondary: theme.vars?.palette.text.secondary ?? theme.palette.text.secondary,
  background: theme.vars?.palette.level0 ?? theme.palette.background.paper,
  hover: theme.vars?.palette.level2 ?? theme.palette.action.hover,
  active: theme.vars?.palette.level3 ?? theme.palette.action.selected,
});

/** Measure the unclamped text and track layout/content changes. */
const useOverflowMeasurement = (
  maxLines: number,
  children: React.ReactNode,
) => {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const hiddenTypographyRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const measureOverflow = useCallback(() => {
    if (typeof window === "undefined" || !hiddenTypographyRef.current) {
      setIsOverflowing(false);
      return;
    }

    const hiddenNode = hiddenTypographyRef.current;
    const computedStyles = window.getComputedStyle(hiddenNode);
    const lineHeight = parseFloat(computedStyles.lineHeight || "0");

    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      setIsOverflowing(false);
      return;
    }

    const collapsedHeight = lineHeight * maxLines;
    const fullHeight = hiddenNode.scrollHeight;
    setIsOverflowing(fullHeight - collapsedHeight > 1);
  }, [maxLines]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      measureOverflow();
      return;
    }

    const hiddenNode = hiddenTypographyRef.current;
    const containerNode = containerRef.current;
    if (!hiddenNode && !containerNode) {
      measureOverflow();
      return;
    }

    const observer = new ResizeObserver(() => measureOverflow());

    if (hiddenNode) {
      observer.observe(hiddenNode);
    }

    if (containerNode) {
      observer.observe(containerNode);
    }

    measureOverflow();

    return () => {
      observer.disconnect();
    };
  }, [measureOverflow]);

  useEffect(() => {
    measureOverflow();
  }, [measureOverflow, children]);

  return { isOverflowing, hiddenTypographyRef, containerRef };
};

export function TypographyWithMore({
  children,
  maxLines = 3,
  initiallyExpanded = false,
  moreLabel = <FormattedMessage defaultMessage="Show more" />,
  lessLabel = <FormattedMessage defaultMessage="Show less" />,
  sx,
  fontSize,
  lineHeight,
  ...typographyProps
}: TypographyProps & {
  maxLines?: number;
  initiallyExpanded?: boolean;
  moreLabel?: React.ReactNode;
  lessLabel?: React.ReactNode;
  fontSize?: number | string;
  lineHeight?: number | string;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { isOverflowing, hiddenTypographyRef, containerRef } =
    useOverflowMeasurement(maxLines, children);
  const clampStyles = useMemo(() => defaultClampStyles(maxLines), [maxLines]);

  const toggleExpanded = () => setExpanded((prev) => !prev);
  const shouldClamp = isOverflowing && !expanded;

  const typographySx = useMemo(
    () => (shouldClamp ? clampedSx(clampStyles, sx) : sx),
    [clampStyles, shouldClamp, sx],
  );
  const hiddenTypographySx = useMemo(() => {
    const baseDisplay = { display: "block" } as const;

    if (!sx) {
      return baseDisplay;
    }

    if (Array.isArray(sx)) {
      return [baseDisplay, ...sx];
    }

    return [baseDisplay, sx];
  }, [sx]);

  const renderToggleButton = (inline: boolean) => (
    <Button
      size="small"
      variant="text"
      onClick={toggleExpanded}
      sx={(theme) => {
        const variantKey = typographyProps.variant ?? "body2";
        const variantStyles =
          (theme.typography as Record<string, any>)[variantKey] ??
          theme.typography.body2;
        const fontSizeResolved =
          fontSize !== undefined ? fontSize : variantStyles.fontSize;
        const lineHeightResolved =
          lineHeight !== undefined
            ? lineHeight
            : (variantStyles.lineHeight ?? 1.35);
        const palette = disclosurePalette(theme);

        // The revealed state for the inline control, and for the out-of-flow
        // chip. Declared once each and reused by :hover, :focus-visible and the
        // no-hover media query, so a change to one reaches the others.
        const inlineReveal = {
          color: palette.primary,
          textDecorationColor: "currentColor",
          backgroundColor: palette.background,
        };
        const chipReveal = {
          color: palette.primary,
          backgroundColor: palette.hover,
        };

        return {
          px: 0,
          minWidth: 0,
          fontSize: fontSizeResolved,
          lineHeight: lineHeightResolved,
          textTransform: "none",
          // De-emphasized at rest so the disclosure control never competes
          // with the content. The affordance is revealed on hover, on
          // keyboard focus, and at rest wherever there is no hover to trigger
          // it. `reveal` below is the single definition of that state, so the
          // three paths cannot drift apart.
          fontWeight: theme.typography.fontWeightMedium,
          color: palette.secondary,
          textDecoration: "underline",
          textDecorationColor: "transparent",
          textUnderlineOffset: 3,
          transition: `color 150ms ${theme.transitions.easing.easeOut}, background-color 150ms ${theme.transitions.easing.easeOut}, text-decoration-color 150ms ${theme.transitions.easing.easeOut}, transform 120ms ${theme.transitions.easing.easeOut}`,
          ...(inline
            ? {
                position: "absolute" as const,
                right: 0,
                bottom: 0,
                mt: 0,
                py: 0,
                borderRadius: 999,
                // This background doubles as the truncation fade. Keep it
                // painted on reveal (a repaint would double-tone the mask)
                // and signal interactivity with color + underline instead —
                // the link affordance for in-flow text toggles.
                backgroundColor: palette.background,
                boxShadow: `-12px 0 12px ${palette.background}`,
                "&:hover": inlineReveal,
                "&:focus-visible": inlineReveal,
                // A pointer that cannot hover never fires :hover, so on touch
                // the underline is the only thing telling the user this is a
                // control. Paint it at rest there rather than leaving a
                // truncated transcript with no affordance at all.
                [`@media ${noHoverQuery}`]: inlineReveal,
              }
            : {
                // Ghost chip for the out-of-flow toggle: comfortable padding
                // and the surface ladder's hover tier, same language as the
                // theme's other quiet buttons.
                mt: 0.5,
                display: "block",
                ml: "auto",
                px: 1,
                py: 0.25,
                borderRadius: 0.75,
                "&:hover": chipReveal,
                "&:focus-visible": chipReveal,
                // Same reasoning as the inline variant: the chip's surface
                // tier is its affordance, and a touch device never hovers.
                [`@media ${noHoverQuery}`]: chipReveal,
                "&:active": {
                  backgroundColor: palette.active,
                },
              }),
        };
      }}
    >
      {expanded ? lessLabel : moreLabel}
    </Button>
  );

  return (
    <Box>
      <Box ref={containerRef} sx={{ position: "relative" }}>
        <Typography {...typographyProps} sx={typographySx}>
          {children}
        </Typography>

        {isOverflowing && shouldClamp ? renderToggleButton(true) : null}

        <Box
          sx={{
            visibility: "hidden",
            position: "absolute",
            pointerEvents: "none",
            zIndex: -1,
            left: 0,
            right: 0,
            width: "100%",
            display: "block",
          }}
        >
          <Typography
            {...typographyProps}
            ref={hiddenTypographyRef}
            aria-hidden
            sx={hiddenTypographySx}
          >
            {children}
          </Typography>
        </Box>
      </Box>
      {isOverflowing && !shouldClamp ? renderToggleButton(false) : null}
    </Box>
  );
}

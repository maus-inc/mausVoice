import { Box, Button, Typography, type TypographyProps } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";

type TypographyWithMoreProps = TypographyProps & {
  maxLines?: number;
  initiallyExpanded?: boolean;
  moreLabel?: React.ReactNode;
  lessLabel?: React.ReactNode;
  fontSize?: number | string;
  lineHeight?: number | string;
};

const defaultClampStyles = (maxLines: number) => ({
  display: "-webkit-box",
  WebkitLineClamp: maxLines,
  WebkitBoxOrient: "vertical" as const,
  overflow: "hidden",
});

const normalizeSxProp = (
  baseClampStyles: Record<string, unknown>,
  shouldClamp: boolean,
  sx: TypographyProps["sx"],
): TypographyProps["sx"] => {
  if (!shouldClamp) {
    return sx;
  }

  return { ...baseClampStyles, ...sx };
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
}: TypographyWithMoreProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const hiddenTypographyRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const clampStyles = useMemo(() => defaultClampStyles(maxLines), [maxLines]);

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

  const toggleExpanded = () => setExpanded((prev) => !prev);
  const shouldClamp = isOverflowing && !expanded;

  const typographySx = useMemo(() => {
    const normalized = normalizeSxProp(clampStyles, shouldClamp, sx);

    if (!shouldClamp) {
      return normalized;
    }

    const paddingAdjustment = { pr: 6 } as const;

    if (Array.isArray(normalized)) {
      return [...normalized, paddingAdjustment];
    }

    if (normalized) {
      return [normalized, paddingAdjustment];
    }

    return paddingAdjustment;
  }, [clampStyles, shouldClamp, sx]);
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
        const textPrimary =
          theme.vars?.palette.text.primary ?? theme.palette.text.primary;
        const textSecondary =
          theme.vars?.palette.text.secondary ?? theme.palette.text.secondary;

        return {
          px: 0,
          minWidth: 0,
          fontSize: fontSizeResolved,
          lineHeight: lineHeightResolved,
          textTransform: "none",
          // De-emphasized at rest so the disclosure control never competes
          // with the content; it strengthens on hover instead.
          fontWeight: theme.typography.fontWeightMedium,
          color: textSecondary,
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
                // painted on hover (a repaint would double-tone the mask)
                // and signal interactivity with color + underline instead —
                // the link affordance for in-flow text toggles.
                backgroundColor:
                  theme.vars?.palette.level0 ?? theme.palette.background.paper,
                boxShadow: `-12px 0 12px ${
                  theme.vars?.palette.level0 ?? theme.palette.background.paper
                }`,
                "&:hover": {
                  color: textPrimary,
                  textDecorationColor: "currentColor",
                  backgroundColor:
                    theme.vars?.palette.level0 ??
                    theme.palette.background.paper,
                },
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
                borderRadius: 2,
                "&:hover": {
                  color: textPrimary,
                  backgroundColor:
                    theme.vars?.palette.level2 ?? theme.palette.action.hover,
                },
                "&:active": {
                  backgroundColor:
                    theme.vars?.palette.level3 ?? theme.palette.action.selected,
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

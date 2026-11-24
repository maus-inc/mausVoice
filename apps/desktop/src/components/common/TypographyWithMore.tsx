import { Box, Button, Typography, type TypographyProps } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { FormattedMessage } from "react-intl";
import {
  defaultClampStyles,
  resolveHiddenTypographySx,
  resolveTypographySx,
  toggleButtonSx,
  type ToggleStyleOptions,
} from "./typography-with-more.styles";

type TypographyWithMoreProps = TypographyProps & {
  maxLines?: number;
  initiallyExpanded?: boolean;
  moreLabel?: ReactNode;
  lessLabel?: ReactNode;
  fontSize?: number | string;
  lineHeight?: number | string;
  clampPaddingRight?: number | string;
  inlineToggleRight?: number | string;
};

type MoreToggleProps = ToggleStyleOptions & {
  expanded: boolean;
  moreLabel: ReactNode;
  lessLabel: ReactNode;
  onToggle: () => void;
};

const MoreToggle = ({
  expanded,
  moreLabel,
  lessLabel,
  onToggle,
  ...styleOptions
}: MoreToggleProps) => (
  <Button
    size="small"
    variant="text"
    onClick={onToggle}
    sx={toggleButtonSx(styleOptions)}
  >
    {expanded ? lessLabel : moreLabel}
  </Button>
);

const MoreToggleSlot = ({
  show,
  ...toggle
}: MoreToggleProps & { show: boolean }) =>
  show ? <MoreToggle {...toggle} /> : null;

/** Tracks whether the unclamped text is taller than its clamp. */
const useOverflowMeasurement = (
  maxLines: number,
  hiddenTypographyRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLDivElement | null>,
): { isOverflowing: boolean; measureOverflow: () => void } => {
  const [isOverflowing, setIsOverflowing] = useState(false);

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
  }, [maxLines, hiddenTypographyRef]);

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
  }, [measureOverflow, hiddenTypographyRef, containerRef]);

  return { isOverflowing, measureOverflow };
};

type TypographyWithMoreState = {
  containerRef: RefObject<HTMLDivElement | null>;
  hiddenTypographyRef: RefObject<HTMLElement | null>;
  expanded: boolean;
  toggleExpanded: () => void;
  typographySx: TypographyProps["sx"];
  hiddenTypographySx: TypographyProps["sx"];
  showInlineToggle: boolean;
  showBlockToggle: boolean;
};

/** Clamp state, overflow measurement and both `sx` payloads for the surface. */
const useTypographyWithMore = ({
  maxLines,
  initiallyExpanded,
  children,
  sx,
  clampPaddingRight,
  inlineToggleRight,
}: {
  maxLines: number;
  initiallyExpanded: boolean;
  children: ReactNode;
  sx: TypographyProps["sx"];
  clampPaddingRight: number | string | undefined;
  inlineToggleRight: number | string | undefined;
}): TypographyWithMoreState => {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const hiddenTypographyRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { isOverflowing, measureOverflow } = useOverflowMeasurement(
    maxLines,
    hiddenTypographyRef,
    containerRef,
  );

  const clampStyles = useMemo(() => defaultClampStyles(maxLines), [maxLines]);
  const shouldClamp = isOverflowing && !expanded;

  useEffect(() => {
    measureOverflow();
  }, [measureOverflow, children]);

  const typographySx = useMemo(
    () =>
      resolveTypographySx({
        clampStyles,
        shouldClamp,
        sx,
        clampPaddingRight,
        inlineToggleRight,
      }),
    [clampPaddingRight, clampStyles, inlineToggleRight, shouldClamp, sx],
  );
  const hiddenTypographySx = useMemo(
    () => resolveHiddenTypographySx(clampPaddingRight, inlineToggleRight, sx),
    [clampPaddingRight, inlineToggleRight, sx],
  );

  return {
    containerRef,
    hiddenTypographyRef,
    expanded,
    toggleExpanded: () => setExpanded((prev) => !prev),
    typographySx,
    hiddenTypographySx,
    showInlineToggle: isOverflowing && shouldClamp,
    showBlockToggle: isOverflowing && !shouldClamp,
  };
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
  clampPaddingRight,
  inlineToggleRight,
  ...typographyProps
}: TypographyWithMoreProps) {
  const state = useTypographyWithMore({
    maxLines,
    initiallyExpanded,
    children,
    sx,
    clampPaddingRight,
    inlineToggleRight,
  });
  const toggleOptions: ToggleStyleOptions = {
    inline: false,
    fontSize,
    lineHeight,
    inlineToggleRight,
    variant: typographyProps.variant,
  };

  return (
    <Box>
      <Box
        ref={state.containerRef}
        sx={{
          position: "relative",
          containerName: "typography-with-more",
          containerType: "inline-size",
        }}
      >
        <Typography {...typographyProps} sx={state.typographySx}>
          {children}
        </Typography>

        <MoreToggleSlot
          {...toggleOptions}
          inline
          show={state.showInlineToggle}
          expanded={state.expanded}
          moreLabel={moreLabel}
          lessLabel={lessLabel}
          onToggle={state.toggleExpanded}
        />

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
            ref={state.hiddenTypographyRef}
            aria-hidden
            sx={state.hiddenTypographySx}
          >
            {children}
          </Typography>
        </Box>
      </Box>
      <MoreToggleSlot
        {...toggleOptions}
        show={state.showBlockToggle}
        expanded={state.expanded}
        moreLabel={moreLabel}
        lessLabel={lessLabel}
        onToggle={state.toggleExpanded}
      />
    </Box>
  );
}

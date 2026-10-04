import {
  Box,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
  type SxProps,
} from "@mui/material";
import { forwardRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OverflowTypography } from "./OverflowTypography";

type HoverButtonProps = {
  idle?: React.ReactNode;
  hover?: React.ReactNode;
  hovered?: boolean;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  left?: boolean;
};

const HoverButton = ({
  idle,
  hover,
  hovered,
  onClick,
  left,
}: HoverButtonProps) => {
  const hoverState = hovered && hover;

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onClick?.(event);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  return (
    <Box
      sx={{
        flexShrink: 0,
        display: "inline-flex",
        ml: left ? undefined : 1,
        mr: left ? 1 : undefined,
      }}
    >
      <Typography
        variant="body2"
        component="span"
        sx={{
          fontWeight: "bold",
          display: "flex",
          alignItems: "center",
        }}
      >
        <Box sx={{ display: hoverState ? "none" : "inline-flex" }}>{idle}</Box>
        <IconButton
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          component="div"
          size="small"
          sx={{
            my: -1,
            mr: left ? undefined : -1.5,
            ml: left ? -1.5 : undefined,
            display: hoverState ? "inline-flex" : "none",
          }}
        >
          {hover}
        </IconButton>
      </Typography>
    </Box>
  );
};

export type ListTileComponent = "div" | "li";

export type ListTileProps<C extends ListTileComponent = "div"> = {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  trailingHover?: React.ReactNode;
  trailingOnClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  leading?: React.ReactNode;
  leadingHover?: React.ReactNode;
  leadingOnClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  selected?: boolean;
  ariaCurrent?: React.AriaAttributes["aria-current"];
  /**
   * Render as a list item when this tile is a child of a List. The generic
   * parameter is what makes the forwarded ref honest: a `li` tile hands back an
   * `HTMLLIElement`, and advertising `HTMLDivElement` let a consumer reach for
   * `div`-only members on an element that has none.
   */
  component?: C;
  sx?: SxProps;
  href?: string;
  disabled?: boolean;
  disableRipple?: boolean;
  /** Optional indicator slot (e.g. motion layoutId pill) rendered behind content */
  indicator?: React.ReactNode;
};

/** The element a `ListTile` renders, which its ref must therefore point at. */
export type ListTileElement<C extends ListTileComponent> = C extends "li"
  ? HTMLLIElement
  : HTMLDivElement;

export const ListTile = forwardRef(function ListTile<
  C extends ListTileComponent = "div",
>(
  {
    title,
    subtitle,
    trailing,
    trailingHover,
    trailingOnClick,
    leading,
    leadingHover,
    leadingOnClick,
    onClick,
    selected = false,
    ariaCurrent,
    component = "div" as C,
    sx,
    href,
    disabled,
    disableRipple = true,
    indicator,
  }: ListTileProps<C>,
  ref: React.Ref<ListTileElement<C>>,
) {
  const [hovered, setHovered] = useState(false);
  const nav = useNavigate();

  const onMouseEnter = () => {
    setHovered(true);
  };

  const onMouseLeave = () => {
    setHovered(false);
  };

  const handleClickLeading = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    leadingOnClick?.(event);
  };

  const handleClickTrailing = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    trailingOnClick?.(event);
  };

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (href) {
      if (event.metaKey || event.ctrlKey) {
        window.open(href, "_blank");
      } else {
        event.preventDefault();
        nav(href);
      }
    }

    onClick?.(event);
  };

  // Normalize sx to array form for MUI
  let normalizedSx: SxProps[] = [];
  if (Array.isArray(sx)) {
    normalizedSx = sx as unknown as SxProps[];
  } else if (sx != null) {
    normalizedSx = [sx];
  }

  const body = (
    <>
      {indicator}
      <ListItemButton
        selected={selected}
        aria-current={ariaCurrent}
        onClick={handleClick}
        disabled={disabled}
        disableRipple={disableRipple}
        sx={(theme) => ({
          position: "relative",
          zIndex: 1,
          transformOrigin: "center",
          // No will-change: transform is already compositor-friendly and
          // adding a layer for every row would cost GPU memory on long lists.
          // Tested on macOS Apple Silicon, macOS Intel, Windows 11, and
          // Linux with integrated GPU. Press stays smooth without the hint.
          // Re-add willChange only if jank appears on low-end devices.
          transition: [
            theme.transitions.create("background-color", {
              duration: theme.transitions.duration.shortest,
            }),
            "transform 90ms var(--ease-out-cubic)",
          ].join(", "),
          "&:active:not(:disabled), &:focus-visible:active:not(:disabled), &.Mui-focusVisible:active:not(:disabled)":
            {
              transform: "scale(0.96)",
            },
          "@media (prefers-reduced-motion: reduce)": {
            transition: "none",
            "&:active:not(:disabled), &:focus-visible:active:not(:disabled), &.Mui-focusVisible:active:not(:disabled)":
              {
                transform: "none",
              },
          },
        })}
      >
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            width: "100%",
          }}
        >
          {Boolean(leading) && (
            <HoverButton
              idle={leading}
              hover={leadingHover}
              hovered={hovered}
              onClick={handleClickLeading}
              left
            />
          )}
          <Box
            sx={{
              flexGrow: 1,
              overflow: "hidden",
            }}
          >
            <ListItemText
              primary={<OverflowTypography>{title}</OverflowTypography>}
              secondary={subtitle}
            />
          </Box>
          {Boolean(trailing) && (
            <HoverButton
              idle={trailing}
              hover={trailingHover}
              hovered={hovered}
              onClick={handleClickTrailing}
              left={false}
            />
          )}
        </Stack>
      </ListItemButton>
    </>
  );

  const shellProps = {
    disablePadding: true,
    onMouseEnter,
    onMouseLeave,
    onFocusCapture: () => setHovered(true),
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        setHovered(false);
      }
    },
    sx: [{ position: "relative" }, ...normalizedSx] as SxProps,
  };

  // `ListItem` declares `component` through a generic overload that cannot
  // accept a ref for an unresolved `C`, so each element is named literally
  // here. That is what lets the forwarded ref carry the real element type
  // instead of being widened away to `HTMLDivElement` for both.
  return component === "li" ? (
    <ListItem
      component="li"
      ref={ref as React.Ref<HTMLLIElement>}
      {...shellProps}
    >
      {body}
    </ListItem>
  ) : (
    <ListItem
      component="div"
      ref={ref as React.Ref<HTMLDivElement>}
      {...shellProps}
    >
      {body}
    </ListItem>
  );
}) as <C extends ListTileComponent = "div">(
  props: ListTileProps<C> & { ref?: React.Ref<ListTileElement<C>> },
) => React.ReactElement;

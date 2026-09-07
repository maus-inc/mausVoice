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

export type ListTileProps = {
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
  sx?: SxProps;
  href?: string;
  disabled?: boolean;
  disableRipple?: boolean;
  /** Optional indicator slot (e.g. motion layoutId pill) rendered behind content */
  indicator?: React.ReactNode;
};

export const ListTile = forwardRef<HTMLDivElement, ListTileProps>(
  (
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
      sx,
      href,
      disabled,
      disableRipple = true,
      indicator,
    },
    ref,
  ) => {
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

    return (
      <ListItem
        ref={ref}
        component="div"
        disablePadding
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        sx={[{ position: "relative" }, ...normalizedSx] as any}
      >
        {indicator}
        <ListItemButton
          selected={selected}
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
            "&:active:not(:disabled), &:focus-visible:not(:disabled), &.Mui-focusVisible:not(:disabled)":
              {
                transform: "scale(0.975)",
              },
            "@media (prefers-reduced-motion: reduce)": {
              transition: "none",
              "&:active:not(:disabled), &:focus-visible:not(:disabled), &.Mui-focusVisible:not(:disabled)":
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
                left={true}
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
      </ListItem>
    );
  },
);
